/**
 * ライフプラン＆キャッシュフロー診断 ― 受信・判定・記録
 *
 * このファイルが「診断ロジックの本体」です。
 * 閾値や診断タイプの文言はすべてここにあり、ブラウザ側からは一切見えません。
 * 判定基準を変えたいときは JUDGE 以下だけを編集してください。
 *
 * === 導入手順 ===
 *  1. 記録用のスプレッドシートを新規作成し、URL 内の ID をコピー
 *     https://docs.google.com/spreadsheets/d/★この部分がID★/edit
 *  2. 下の CONFIG.SHEET_ID に貼り付ける
 *  3. CONFIG.TOKEN に好きな合言葉を設定（index.html 側の CONFIG.token と同じ値にする）
 *  4. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *       次のユーザーとして実行 : 自分
 *       アクセスできるユーザー : 全員
 *  5. 発行されたウェブアプリURLを index.html の CONFIG.endpoint に貼り付ける
 *
 *  ※ ロジックを修正したら、必ず「デプロイを管理」→ 鉛筆アイコン →
 *     バージョン「新バージョン」で再デプロイしてください（URLは変わりません）。
 */

const CONFIG = {
  SHEET_ID:   '1tqN5fkAs86iEJ_CiqxGDwdp-0-dbOobxuVB1Ui55OpM',
  SHEET_NAME: 'responses',
  TOKEN:      'test',  // index.html の CONFIG.token と一致させること

  // ★ スプレッドシートへの記録のスイッチ。
  //    false … 判定結果だけ返し、1行も書き込まない（専用サーバーへ移すまではこちら）
  //    true  … 従来どおり responses シートに1件1行で記録する
  RECORD:     false
};

/** スプレッドシートの列順。末尾への追加は安全。並べ替え・削除は既存データとズレるので注意。 */
const COLS = [
  'ts', 'sessionId', 'staff', 'source', 'appVersion', 'consentVersion', 'consentedAt',
  // --- 属性 ---
  'user_age', 'gender', 'pref', 'household', 'children', 'youngest_child_age',
  'housing', 'employment', 'dual_income', 'topics', 'working_years',
  // --- 収入 ---
  'inc_gross', 'inc_net', 'bonus_count', 'bonus_total', 'annualIncome',
  // --- 資産・負債 ---
  // ast_other は v1.5.0 から「その他の金融資産」の意味に変わっています
  'ast_ordinary', 'ast_time', 'ast_other', 'totalAssets', 'debt_total', 'netWorth',
  // --- 固定費 ---
  'fx_rent', 'fx_elec', 'fx_gas', 'fx_water', 'fx_mobile', 'fx_net',
  'fx_ins_car', 'fx_ins_med', 'fx_ins_life', 'fx_ins_other', 'fx_loan', 'fx_scholarship',
  // --- 変動費 ---
  'vr_food_home', 'vr_food_out', 'vr_gasoline', 'vr_transport', 'vr_medical', 'vr_edu',
  'vr_clothes', 'vr_hair', 'vr_cosme', 'vr_hobby', 'otherItems',
  // --- 集計 ---
  'monthlyFixed', 'monthlyVar', 'monthlyTotalExp', 'annualTotalExp',
  'monthlySavings', 'annualSavings',
  // --- 判定 ---
  'conversionRate', 'peerPercentile', 'efficiencyRate', 'fireProgressRate',
  'score1', 'score2', 'score3', 'score4', 'totalScore', 'typeName',
  // --- ④の前提（v1.1.0 で追加。列は必ず末尾に足すこと）---
  'assumedPensionMonthly', 'assumedPensionAnnual', 'pensionBasis', 'requiredAssetsForFire',
  // --- v1.2.0 で追加 ---
  'spouse_employment',
  // --- v1.3.0 で追加（②の比較根拠）---
  'peerGroupLabel', 'peerMedian', 'peerMean',
  // --- v1.4.0 で追加（①の算定根拠）---
  'lifetimeIncome', 'careerStartAge', 'careerYears',
  // --- v1.5.0 で追加（③の資産内訳と④の老後支出）---
  'ast_invest', 'ast_dc', 'ast_insurance', 'operationalAssets',
  'retireMonthlyExp', 'retireAnnualExp', 'retireDropped',
  // --- v1.6.0 で追加（借入を種類別に分離。既存列を守るため末尾に追加）---
  'has_debt', 'debt_student', 'debt_car', 'debt_card', 'debt_other', 'debt_mortgage',
  'fx_student', 'fx_car_loan', 'fx_card_loan', 'fx_other_loan',
  'debtPaymentRate', 'debtCondition', 'debtMessage'
];


// ==========================================================
// 公的統計テーブル
//
// ★年1回（毎年12月頃に新年度版が公表されます）見直してください。
//   見直したら STATS_UPDATED と CONFIG の appVersion を更新すること。
// ==========================================================

/**
 * 想定年金額（1人あたりの老齢年金 月額・老齢基礎年金を含む）
 *
 * 出典1: 厚生労働省年金局「令和6年度 厚生年金保険・国民年金事業の概況」
 *        （令和6年度末現在）https://www.mhlw.go.jp/content/001617995.pdf
 *        - KOSEI        : 表9「厚生年金保険（第1号）受給権者平均年金月額の推移」老齢年金
 *        - DAI3GO       : 表23「国民年金 受給権者の平均年金月額の推移」老齢年金・25年以上
 *        - KOKUMIN_ONLY : 同表23のうち［基礎のみ共済なし・旧国年］再掲値
 * 出典2: 日本年金機構「老齢基礎年金の受給要件・支給開始時期・年金額」（令和8年4月分から）
 *        https://www.nenkin.go.jp/service/jukyu/seido/roureinenkin/jukyu-yoken/20150401-02.html
 *        - MANGAKU : 老齢基礎年金の満額 847,300円/年（昭和31年4月2日以後生まれ）
 */
const PENSION = {
  KOSEI:        150289,   // 厚生年金あり（会社員・公務員等）の実績平均
  DAI3GO:        59310,   // 国民年金 老齢年金の実績平均（第3号被保険者＝専業主婦等の目安）
  KOKUMIN_ONLY:  54353,   // 国民年金のみ（自営業等）の実績平均
  MANGAKU:  Math.round(847300 / 12),  // 老齢基礎年金 満額の月額換算（参考値）

  // --- 男女別の実績値（表12・表13の65歳以上）---
  // 厚生年金は男女で実績が大きく異なるため、性別が分かる場合はこちらを使います。
  // ※注意：これは「現在65歳以上の世代」の実績です。共働きが一般化した現役世代の
  //   女性にそのまま当てはめると、見込みを過小評価する可能性があります。
  //   性別で分けたくない場合は pensionForPerson() で常に KOSEI を返すようにしてください。
  KOSEI_M:      173033,   // 厚生年金 老齢年金受給権者 男子65歳以上
  KOSEI_F:      114797    // 厚生年金 老齢年金受給権者 女子65歳以上
};

const STATS_SOURCE  = '厚生労働省「令和6年度 厚生年金保険・国民年金事業の概況」ほか';
const STATS_UPDATED = '2026-09-21';

/**
 * 65歳以上の無職世帯の家計収支（月平均・円）
 *
 * 出典: 総務省統計局「家計調査年報（家計収支編）2025年」
 *       表2 65歳以上の夫婦のみの無職世帯及び65歳以上の単身無職世帯の家計収支
 *       https://www.stat.go.jp/data/kakei/2025np/pdf/summary.pdf
 *
 * ④の「老後の支出」を推計するとき、医療費の増加分の目安として medical を使います。
 * consumption と benefit は、推計結果が実態からかけ離れていないかを面談で
 * 確認してもらうための参考値として結果画面に表示します。
 *
 * 参考：夫婦高齢者無職世帯の社会保障給付は月228,614円（年約274万円）で、
 *      本ツールの年金推計（会社員＋第3号で年約279万円）とほぼ一致します。
 */
const ELDERLY_HH = {
  // deficit: 実収入から消費支出・非消費支出を引いた差額（＝毎月の赤字額）。
  //          高齢無職世帯は平均して資産を取り崩しながら生活しており、
  //          「年金で支出を賄えるか」だけでは備えの必要額を測れないため、
  //          この実績値を必要資産の下限として使います。
  COUPLE: { medical: 17941, consumption: 263979, benefit: 228614, deficit: 42434,
            label: '65歳以上の夫婦のみの無職世帯' },
  SINGLE: { medical:  8388, consumption: 148445, benefit: 120212, deficit: 29980,
            label: '65歳以上の単身無職世帯' }
};

const ELDERLY_SOURCE = '総務省統計局「家計調査年報（家計収支編）2025年」';

/**
 * 老後（65歳以降）の支出を、現在の支出から補正して推計する。
 *
 * 旧来は「老後の支出＝現在の支出」としていましたが、実際には教育費や
 * ローン返済は終わり、逆に医療費は増えます。本人が入力した金額をもとに
 * 無くなる費目を差し引き、医療費は家計調査の高齢者世帯の水準まで引き上げます。
 *
 * 【この推計が置いている仮定】
 *  - 教育費・奨学金返済・その他ローン返済は65歳までに終わる
 *  - 住宅ローンは「持ち家（住宅ローン返済中）」の場合のみ終わる。
 *    賃貸・社宅・実家は住居費が続くものとみなす
 *  - 医療費は家計調査の高齢者世帯の実績（夫婦17,941円／単身8,388円）まで増える
 *  - 介護費用・住宅の修繕費・インフレは見込んでいない（いずれも支出を増やす方向）
 */
function estimateRetirementExpense(d, monthlyTotalExp) {
  const n = function (v) { return Number(v) || 0; };
  const ref = (d.household === '独身（単身）') ? ELDERLY_HH.SINGLE : ELDERLY_HH.COUPLE;

  const dropped = [];
  let cut = 0;

  if (n(d.vr_edu) > 0)          { cut += n(d.vr_edu);          dropped.push('教育費'); }
  const studentPay = n(d.fx_student) || n(d.fx_scholarship);
  const otherDebtPay = n(d.fx_car_loan) + n(d.fx_card_loan) + n(d.fx_other_loan) || n(d.fx_loan);
  if (studentPay > 0)            { cut += studentPay;            dropped.push('奨学金返済'); }
  if (otherDebtPay > 0)          { cut += otherDebtPay;          dropped.push('ローン返済'); }
  if (d.housing === '持ち家（住宅ローン返済中）' && n(d.fx_rent) > 0) {
    cut += n(d.fx_rent);
    dropped.push('住宅ローン');
  }

  const medicalUplift = Math.max(0, ref.medical - n(d.vr_medical));
  const monthly = Math.max(0, monthlyTotalExp - cut + medicalUplift);

  return {
    monthly:        monthly,
    annual:         monthly * 12,
    cut:            cut,
    dropped:        dropped.length ? dropped.join('・') : 'なし',
    medicalUplift:  medicalUplift,
    refLabel:       ref.label,
    refConsumption: ref.consumption,
    refDeficit:     ref.deficit
  };
}


/**
 * 年齢階級別の賃金カーブ（きまって支給する現金給与額・千円）
 *
 * 出典: 厚生労働省「令和7年賃金構造基本統計調査」
 *       第2表 性、年齢階級別賃金、対前年増減率及び年齢階級間賃金格差
 *       https://www.mhlw.go.jp/toukei/itiran/roudou/chingin/kouzou/z2025/dl/14.pdf
 *       （令和7年6月分の賃金・一般労働者）
 *
 * 金額そのものではなく「年齢による水準の比」だけを使います。
 * 現在の収入を起点に、過去の各年の収入水準をこの比で割り戻して累計します。
 */
const WAGE_BAND_MAX = [19, 24, 29, 34, 39, 44, 49, 54, 59, 64, 69];
const WAGE_CURVE = {
  ALL: [208.3, 242.8, 279.4, 312.3, 340.6, 364.3, 377.9, 388.8, 396.2, 329.3, 285.3],
  M:   [212.5, 245.7, 288.0, 330.4, 366.2, 398.2, 420.7, 437.5, 445.6, 358.5, 304.3],
  F:   [201.4, 239.6, 268.8, 283.2, 292.4, 303.6, 305.7, 305.4, 305.7, 270.8, 240.7]
};

const WAGE_SOURCE = '厚生労働省「令和7年賃金構造基本統計調査」';

/** その年齢の賃金水準を返す。70歳以上は65～69歳の水準で据え置く。 */
function wageIndexAt(age, gender) {
  const arr = (gender === '男性') ? WAGE_CURVE.M
            : (gender === '女性') ? WAGE_CURVE.F
            : WAGE_CURVE.ALL;
  for (let i = 0; i < WAGE_BAND_MAX.length; i++) {
    if (age <= WAGE_BAND_MAX[i]) return arr[i];
  }
  return arr[arr.length - 1];
}

/**
 * 就業開始から現在までの累計収入を推計する。
 *
 * 旧来は「現在の年収 × 勤続年数」で代用していましたが、日本の賃金カーブは
 * 右肩上がりのため、過去の収入を実際より多く見積もることになり、
 * 年齢が上がるほど「残す力」が不当に低く出ていました。
 * ここでは現在の収入を起点に、賃金カーブの比で各年の収入を割り戻して合算します。
 *
 * 【この推計が置いている仮定】
 *  - 本人の収入が、同性・同年齢の平均的な賃金カーブに沿って推移してきたとみなす
 *  - 賃金カーブは額面ベース、本人の入力は手取りベース。累進課税により手取りの
 *    伸びは額面より緩やかなので、過去の収入をやや低めに見積もる傾向がある
 *  - 賃金カーブに賞与は含まれない。賞与は年齢とともにより急に伸びるため、
 *    上記とは逆に過去の収入をやや高めに見積もる方向に働く（両者は一部相殺する）
 *  - 転職・休職・独立などの個別事情は反映されない
 */
function estimateLifetimeIncome(annualIncome, age, workingYears, gender) {
  const a = Number(age) || 0;
  const inc = Number(annualIncome) || 0;
  // 15歳より前に働き始めることはないものとして勤続年数を丸める（入力ミス対策）
  const years = Math.min(Math.max(0, Math.round(Number(workingYears) || 0)),
                         Math.max(0, a - 15));

  if (years <= 0 || inc <= 0) {
    return { total: 0, ratio: 0, startAge: a, years: 0 };
  }

  const nowIdx = wageIndexAt(a, gender);
  const startAge = a - years;

  let ratio = 0;
  for (let y = startAge; y < a; y++) {
    ratio += wageIndexAt(y, gender) / nowIdx;
  }

  return {
    total:    Math.round(inc * ratio),
    ratio:    Math.round(ratio * 100) / 100,
    startAge: startAge,
    years:    years
  };
}


/**
 * 年代別・世帯類型別の金融資産保有額の分布
 *
 * 出典: 金融経済教育推進機構（J-FLEC）
 *       「家計の金融行動に関する世論調査（2025年）」各種分類別データ（令和7年）
 *       設問2(a)「金融資産保有額（金融資産を保有していない世帯を含む）」世帯主の年令別
 *       二人以上世帯 https://www.j-flec.go.jp/wpimages/uploads/per22501.xlsx
 *       単身世帯     https://www.j-flec.go.jp/wpimages/uploads/per12501.xlsx
 *       調査時期: 令和7年6月20日～7月2日（インターネットモニター調査）
 *       ※2026年1月21日付の訂正を反映した公開版から取得
 *
 * p  : 保有額階級ごとの世帯構成比（％）。並び順は ASSET_BIN_LOWER / UPPER に対応
 *      [非保有, 100万未満, 100～200, 200～300, 300～400, 400～500,
 *       500～700, 700～1000, 1000～1500, 1500～2000, 2000～3000, 3000万以上]
 * na : 無回答（％）。パーセンタイル計算からは除外して正規化する
 */
const ASSET_DIST = {
  TWO_PLUS: {
    20: { n: 171,  p: [21.6, 16.4, 14.0, 7.0, 8.2, 3.5, 5.3, 3.5, 4.7, 1.2, 4.1, 4.1],   na: 6.4, median: 125,  mean: 525  },
    30: { n: 648,  p: [17.6, 12.7, 9.1, 6.0, 6.0, 4.5, 8.3, 7.4, 9.4, 3.9, 4.6, 7.9],    na: 2.6, median: 311,  mean: 1096 },
    40: { n: 1052, p: [18.8, 10.0, 6.2, 5.1, 4.4, 2.6, 7.3, 6.1, 9.7, 6.5, 8.2, 13.1],   na: 2.1, median: 500,  mean: 1486 },
    50: { n: 1024, p: [18.2, 6.5, 6.4, 4.1, 3.5, 2.2, 6.7, 7.7, 9.3, 6.1, 8.1, 18.8],    na: 2.2, median: 700,  mean: 1908 },
    60: { n: 1022, p: [12.8, 4.7, 3.9, 3.0, 2.8, 1.8, 6.2, 6.3, 8.9, 8.0, 12.4, 27.2],   na: 2.0, median: 1400, mean: 2683 },
    70: { n: 1083, p: [10.9, 4.5, 5.1, 3.7, 3.9, 2.9, 6.4, 6.7, 11.1, 6.7, 12.3, 25.2],  na: 0.6, median: 1178, mean: 2416 }
  },
  SINGLE: {
    20: { n: 548, p: [33.2, 24.6, 10.2, 7.1, 5.5, 3.1, 5.8, 2.6, 2.4, 1.1, 0.5, 0.7],    na: 3.1, median: 37,  mean: 255  },
    30: { n: 325, p: [32.3, 14.2, 14.2, 4.9, 4.3, 2.8, 5.5, 3.1, 5.5, 4.3, 2.5, 3.4],    na: 3.1, median: 100, mean: 501  },
    40: { n: 324, p: [32.1, 15.1, 7.1, 5.9, 4.3, 2.2, 6.2, 4.6, 6.2, 1.2, 2.8, 9.9],     na: 2.5, median: 100, mean: 859  },
    50: { n: 366, p: [35.2, 10.1, 7.4, 4.6, 2.7, 3.3, 4.9, 4.6, 6.0, 3.3, 5.5, 10.4],    na: 1.9, median: 120, mean: 999  },
    60: { n: 418, p: [30.4, 9.1, 4.3, 2.4, 4.5, 3.1, 6.0, 4.8, 8.1, 4.1, 5.5, 15.6],     na: 2.2, median: 300, mean: 1364 },
    70: { n: 519, p: [20.4, 7.1, 8.1, 4.2, 3.7, 3.5, 6.9, 6.4, 7.3, 5.8, 7.9, 17.5],     na: 1.2, median: 500, mean: 1489 }
  }
};

/** 各階級の下限・上限（万円）。最初は「非保有」＝ちょうど0円、最後は上限なし。 */
const ASSET_BIN_LOWER = [0, 0,   100, 200, 300, 400, 500, 700,  1000, 1500, 2000, 3000];
const ASSET_BIN_UPPER = [0, 100, 200, 300, 400, 500, 700, 1000, 1500, 2000, 3000, null];

const PEER_SOURCE = '金融経済教育推進機構「家計の金融行動に関する世論調査（2025年）」';

/** 年齢 → 調査の年代区分（20/30/40/50/60/70）。範囲外は両端に寄せる。 */
function ageBand(age) {
  const a = Number(age) || 0;
  if (a < 30) return 20;
  if (a >= 70) return 70;
  return Math.floor(a / 10) * 10;
}

/** 世帯構成 → 調査の世帯類型。単身以外はすべて二人以上世帯として扱う。 */
function householdType(household) {
  return (household === '独身（単身）') ? 'SINGLE' : 'TWO_PLUS';
}

/**
 * 金融資産額が同年代・同世帯類型の中で上位何％にあたるかを返す。
 *
 * 偏差値ではなくパーセンタイルを使っています。金融資産の分布は右に大きく裾を
 * 引いており（平均が中央値の3倍前後）、偏差値にすると中央値の世帯が50を
 * 大きく下回るなど直感に反する値になるためです。
 *
 * 戻り値 top は小さいほど上位。3000万円以上の階級は上限がなく内挿できないため、
 * その階級に入る場合は capped=true とし「上位◯％以内」と表示します。
 */
function assetPercentile(manYen, dist) {
  const total = dist.p.reduce(function (a, b) { return a + b; }, 0);  // 無回答を除いた合計
  const v = Number(manYen) || 0;

  // 無回答を除いて正規化した構成比と、その階級より下の累積％
  const share = dist.p.map(function (x) { return x / total * 100; });
  const cumLo = [];
  let acc = 0;
  for (let k = 0; k < share.length; k++) { cumLo.push(acc); acc += share[k]; }

  // 金融資産なし（ちょうど0円）は非保有層の中間に位置づける
  if (v <= 0) return { top: round1(100 - share[0] / 2), capped: false };

  // 該当する階級を探す
  let i = 1;
  while (i < share.length - 1 && v >= ASSET_BIN_UPPER[i]) i++;

  const lo = ASSET_BIN_LOWER[i];
  const up = ASSET_BIN_UPPER[i];

  // 3000万円以上は上限がなく内挿できないので「上位◯％以内」とする
  if (up === null) return { top: round1(Math.max(0.1, share[i])), capped: true };

  const start = cumLo[i];
  const end   = start + share[i];
  const med   = dist.median;

  let below;
  if (med > lo && med < up && start < 50 && end > 50) {
    // 階級の中に公表中央値がある場合は、そこがちょうど50％になるよう
    // 階級を2分割して補間する。階級幅が広い若年層での誤差を抑えるため。
    below = (v <= med)
      ? start + (50 - start) * (v - lo) / (med - lo)
      : 50 + (end - 50) * (v - med) / (up - med);
  } else {
    below = start + share[i] * (v - lo) / (up - lo);
  }

  return { top: round1(Math.min(99.9, Math.max(0.1, 100 - below))), capped: false };
}

function round1(v) { return Math.round(v * 10) / 10; }


/** 就業形態 → 想定年金の区分。未知の値は多数派である厚生年金加入者として扱う。 */
const EMPLOY_TO_PENSION = {
  '会社員':               'KOSEI',
  '公務員':               'KOSEI',
  '会社役員':             'KOSEI',
  '年金生活':             'KOSEI',
  '自営業・フリーランス': 'KOKUMIN_ONLY',
  'パート・アルバイト':   'KOKUMIN_ONLY',
  '専業主婦（主夫）':     'DAI3GO',
  'その他':               'KOSEI'
};

/**
 * 1人あたりの想定年金月額（老齢基礎年金を含む）を返す。
 * 厚生年金は男女で実績に大きな差があるため、性別が分かる場合は分けて扱う。
 * 性別が不明・「その他・回答しない」の場合は男女計の平均を使う。
 * 国民年金のみ・第3号については男女別の公表値がないため共通値を使う。
 */
function pensionForPerson(employment, gender) {
  const key = EMPLOY_TO_PENSION[employment] || 'KOSEI';
  if (key !== 'KOSEI') return PENSION[key];
  if (gender === '男性') return PENSION.KOSEI_M;
  if (gender === '女性') return PENSION.KOSEI_F;
  return PENSION.KOSEI;
}

/**
 * 配偶者の性別。統計上の多数派にあわせて異性と仮定している。
 * この仮定を使いたくない場合は、常に '' を返すようにすれば男女計の平均が使われる。
 */
function spouseGenderOf(gender) {
  if (gender === '男性') return '女性';
  if (gender === '女性') return '男性';
  return '';
}

/** 表示用の短いラベル（例：会社員・男性） */
function personLabel(employment, gender) {
  const e = employment || '就業形態不明';
  return (gender === '男性' || gender === '女性') ? (e + '・' + gender) : e;
}

/**
 * 世帯の想定年金額（年額）を推計する。
 *
 * 本人分は「就業形態 × 性別」、配偶者分は「配偶者の就業形態 × 異性と仮定した性別」
 * から算出し、合算する。
 *
 * 【残っている仮定】
 *  - 配偶者の性別は本人の異性とみなしている（spouseGenderOf）
 *  - 配偶者の就業形態が未入力の場合は、片働きなら第3号相当、
 *    共働きなら本人と同じ就業形態とみなす（basis に「推定」と明記される）
 *  - 満額納付ではなく「受給実績の平均」を使っているため、
 *    未納・免除のない方にとっては控えめな見積もりになる
 */
function estimatePension(d) {
  const selfMonthly = pensionForPerson(d.employment, d.gender);
  const selfLabel   = personLabel(d.employment, d.gender);

  const hasSpouse = d.household !== '独身（単身）' && d.household !== 'ひとり親＋子ども'
    && (d.dual_income === '共働き' || d.dual_income === '片働き');

  if (!hasSpouse) {
    return {
      monthly: selfMonthly,
      annual:  selfMonthly * 12,
      basis:   'ご本人：' + selfLabel + '（単身）',
      source:  STATS_SOURCE
    };
  }

  let spouseEmp = d.spouse_employment || '';
  let guessNote = '';
  if (!spouseEmp) {
    spouseEmp = (d.dual_income === '片働き') ? '専業主婦（主夫）' : (d.employment || '');
    guessNote = '（推定）';
  }

  const sGender      = spouseGenderOf(d.gender);
  const spouseMonthly = pensionForPerson(spouseEmp, sGender);
  const monthly       = selfMonthly + spouseMonthly;

  return {
    monthly: monthly,
    annual:  monthly * 12,
    basis:   'ご本人：' + selfLabel
           + ' ／ 配偶者：' + personLabel(spouseEmp, sGender) + guessNote,
    source:  STATS_SOURCE
  };
}


// ==========================================================
// エンドポイント
// ==========================================================

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json({ ok: false, error: 'empty request' });
    }
    const body = JSON.parse(e.postData.contents);

    if (body.token !== CONFIG.TOKEN) {
      return json({ ok: false, error: 'auth' });
    }

    const d = body.data || {};
    const invalid = validateSubmittedNumbers(d);
    if (invalid) return json({ ok: false, error: invalid + ' は0以上の数値で入力してください' });
    const result = judge(d);

    if (CONFIG.RECORD) {
      try {
        appendRow(body, d, result);
      } catch (writeErr) {
        // 記録に失敗しても、お客様への診断結果表示だけは止めない
        console.error('sheet write failed: ' + writeErr);
      }
    }

    return json({ ok: true, result: result });

  } catch (err) {
    console.error(err);
    return json({ ok: false, error: String(err) });
  }
}

function validateSubmittedNumbers(d) {
  const plainNumbers = new Set([
    'user_age', 'youngest_child_age', 'working_years', 'bonus_count',
    'bonus_total', 'annualIncome', 'totalAssets', 'monthlyFixed', 'monthlyVar'
  ]);
  for (const key of Object.keys(d)) {
    if (!(/^(inc_|ast_|debt_|fx_|vr_)/.test(key) || plainNumbers.has(key))) continue;
    const value = Number(d[key]);
    if (!Number.isFinite(value) || value < 0) return key;
  }
  if (Array.isArray(d.otherItems)) {
    for (const item of d.otherItems) {
      if (!Number.isFinite(Number(item.val)) || Number(item.val) < 0) return 'otherItems';
    }
  }
  return '';
}
/** 疎通確認用。ブラウザでウェブアプリURLを開くと {"ok":true,...} が出れば成功。 */
function doGet() {
  return json({ ok: true, msg: 'endpoint alive' });
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


// ==========================================================
// JUDGE ― 診断ロジック本体（ここが非公開部分）
// ==========================================================

function judge(d) {
  const num = v => Number(v) || 0;

  const monthlyFixed    = num(d.monthlyFixed);
  const monthlyVar      = num(d.monthlyVar);
  const monthlyTotalExp = monthlyFixed + monthlyVar;
  const annualTotalExp  = monthlyTotalExp * 12;
  const monthlySavings  = num(d.inc_net) - monthlyTotalExp;
  const annualSavings   = num(d.annualIncome) - annualTotalExp;

  const netWorth      = num(d.netWorth);
  const totalAssets   = num(d.totalAssets);
  const annualIncome  = num(d.annualIncome);
  const workingYears  = num(d.working_years);
  const userAge       = num(d.user_age);

  // --- ① お金を「残す力」（生涯収入から残せた割合） -------------------------------------------------
  // 「現在の年収 × 勤続年数」ではなく、賃金カーブで過去の収入を割り戻して累計する
  const career         = estimateLifetimeIncome(annualIncome, userAge, workingYears, d.gender);
  const lifetimeIncome = career.total;
  // 借入残高はここでは差し引かない。資産形成の努力と返済状態を混ぜないため。
  const conversionRate = lifetimeIncome > 0 ? (totalAssets / lifetimeIncome) * 100 : 0;

  let score1 = 0, text1 = '', class1 = '';
  const careerYears = career.years;
  if (careerYears <= 5) {
    if (conversionRate >= 15)      { score1 = 5; text1 = '優良';    class1 = 'eval-5'; }
    else if (conversionRate >= 8)  { score1 = 4; text1 = '良好';    class1 = 'eval-4'; }
    else if (conversionRate >= 3)  { score1 = 3; text1 = '標準';    class1 = 'eval-3'; }
    else                           { score1 = 1; text1 = '要改善';  class1 = 'eval-1'; }
  } else if (careerYears <= 15) {
    if (conversionRate >= 20)      { score1 = 5; text1 = '優良';    class1 = 'eval-5'; }
    else if (conversionRate >= 12) { score1 = 4; text1 = '良好';    class1 = 'eval-4'; }
    else if (conversionRate >= 6)  { score1 = 3; text1 = '標準';    class1 = 'eval-3'; }
    else                           { score1 = 1; text1 = '要改善';  class1 = 'eval-1'; }
  } else if (careerYears <= 25) {
    if (conversionRate >= 25)      { score1 = 5; text1 = '優良';    class1 = 'eval-5'; }
    else if (conversionRate >= 15) { score1 = 4; text1 = '良好';    class1 = 'eval-4'; }
    else if (conversionRate >= 8)  { score1 = 3; text1 = '標準';    class1 = 'eval-3'; }
    else                           { score1 = 1; text1 = '要改善';  class1 = 'eval-1'; }
  } else {
    if (conversionRate >= 30)      { score1 = 5; text1 = '優良';    class1 = 'eval-5'; }
    else if (conversionRate >= 20) { score1 = 4; text1 = '良好';    class1 = 'eval-4'; }
    else if (conversionRate >= 12) { score1 = 3; text1 = '標準';    class1 = 'eval-3'; }
    else                           { score1 = 1; text1 = '要改善';  class1 = 'eval-1'; }
  }

  // --- ② 資産を「育てる力」（同年代・同世帯類型の中での位置）------------------------------------
  // 公的調査の分布と比較する。調査の「金融資産保有額」は負債を差し引く前の
  // 総額なので、純資産ではなく totalAssets（預貯金＋投資）で比較する。
  const band      = ageBand(userAge);
  const hhType    = householdType(d.household);
  const peerDist  = ASSET_DIST[hhType][band];
  const peerRank  = assetPercentile(totalAssets / 10000, peerDist);

  const peerGroupLabel = (hhType === 'SINGLE' ? '単身世帯' : '二人以上世帯') + '・' + band + '歳代';

  let score2 = 0, text2 = '', class2 = '';
  if (peerRank.top <= 20)      { score2 = 5; text2 = '非常に優秀'; class2 = 'eval-5'; }
  else if (peerRank.top <= 40) { score2 = 4; text2 = '優秀';       class2 = 'eval-4'; }
  else if (peerRank.top <= 60) { score2 = 3; text2 = '標準的';     class2 = 'eval-3'; }
  else if (peerRank.top <= 80) { score2 = 2; text2 = '要改善';     class2 = 'eval-2'; }
  else                         { score2 = 1; text2 = '要緊急対応'; class2 = 'eval-1'; }

  // --- ③ お金を「働かせる力」（余剰資金の投資稼働率）---------------------------
  const livingDefenseFund  = monthlyTotalExp * 6;
  // 運用に回っている資産。貯蓄型保険は利回りが低く流動性も乏しいため、
  // 「運用資産」ではなく「動いていない資産」として扱う（その旨は結果画面に明記）
  const operationalAssets  = num(d.ast_invest) + num(d.ast_dc);
  const effBase            = totalAssets - livingDefenseFund;

  let efficiencyRate = 0;
  if (effBase > 0)                  { efficiencyRate = (operationalAssets / effBase) * 100; }
  else if (operationalAssets > 0)   { efficiencyRate = 100; }

  let score3 = 0, text3 = '', class3 = '';
  if (totalAssets < 3000000) {
    if (effBase <= 0 && operationalAssets === 0)              { score3 = 5; text3 = '優良(現金重視)';      class3 = 'eval-5'; }
    else if (efficiencyRate >= 10 && efficiencyRate <= 20)    { score3 = 4; text3 = '良好';                class3 = 'eval-4'; }
    else if (efficiencyRate >= 5 && efficiencyRate < 10)      { score3 = 3; text3 = '標準';                class3 = 'eval-3'; }
    else if (operationalAssets === 0)                         { score3 = 1; text3 = '要改善(投資未着手)';  class3 = 'eval-1'; }
    else                                                      { score3 = 2; text3 = '注意(現金不足)';      class3 = 'eval-2'; }
  } else if (totalAssets < 10000000) {
    if (efficiencyRate >= 30)      { score3 = 5; text3 = '優良';   class3 = 'eval-5'; }
    else if (efficiencyRate >= 20) { score3 = 4; text3 = '良好';   class3 = 'eval-4'; }
    else if (efficiencyRate >= 10) { score3 = 3; text3 = '標準';   class3 = 'eval-3'; }
    else                           { score3 = 1; text3 = '要改善'; class3 = 'eval-1'; }
  } else {
    if (efficiencyRate >= 50)      { score3 = 5; text3 = '優良';   class3 = 'eval-5'; }
    else if (efficiencyRate >= 35) { score3 = 4; text3 = '良好';   class3 = 'eval-4'; }
    else if (efficiencyRate >= 20) { score3 = 3; text3 = '標準';   class3 = 'eval-3'; }
    else                           { score3 = 1; text3 = '要改善'; class3 = 'eval-1'; }
  }

  // --- ④ 労働から「自由になる力」（早期リタイア達成率） ----------------------------------------------
  // 年金額は就業形態・世帯の働き方から公的統計をもとに推計する（estimatePension を参照）
  const pension                = estimatePension(d);
  const assumedPension         = pension.annual;
  // 老後の支出は現在の支出そのままではなく、無くなる費目と増える医療費を補正する
  const retire                 = estimateRetirementExpense(d, monthlyTotalExp);
  const shortfall              = retire.annual - assumedPension;
  // 不足額の25年分。ただし年金が支出をほぼ賄える世帯では必要額がゼロ近くまで
  // 小さくなり、資産がわずかでも「達成」と出てしまう（25倍ルールの構造的な性質）。
  // 家計調査の高齢無職世帯は平均して毎月赤字で資産を取り崩しているため、
  // その実績赤字額の25年分を「最低限の備え」として下限に置く。
  const requiredFromGap        = shortfall > 0 ? shortfall * 25 : 0;
  const requiredFloor          = retire.refDeficit * 12 * 25;
  const requiredAssetsForFire  = Math.max(requiredFromGap, requiredFloor);
  const floorApplied           = requiredFloor > requiredFromGap;
  const fireProgressRate       = requiredAssetsForFire > 0
    ? (totalAssets / requiredAssetsForFire) * 100
    : 0;

  // 想定年金が支出を上回る場合は「必要資産ゼロ＝目標達成」となってしまう。
  // 資産がほとんど無くても達成扱いになり誤解を招くため、その場合は
  // 達成率ではなく「年金で充足の見込み」という別の表示に切り替える。
  const pensionCoversExpenses = (shortfall <= 0);

  let score4 = 0, text4 = '', class4 = '';
  if (fireProgressRate >= 100)     { score4 = 5; text4 = '目標達成'; class4 = 'eval-5'; }
  else if (fireProgressRate >= 60) { score4 = 4; text4 = '順調';     class4 = 'eval-4'; }
  else if (fireProgressRate >= 30) { score4 = 3; text4 = '標準的';   class4 = 'eval-3'; }
  else if (fireProgressRate >= 10) { score4 = 2; text4 = '要改善';   class4 = 'eval-2'; }
  else                             { score4 = 1; text4 = '準備不足'; class4 = 'eval-1'; }

  // --- 借入・返済コンディション（4指標とは別表示。総合点には含めない）------------
  const debtStudent = num(d.debt_student);
  const debtCar = num(d.debt_car);
  const debtCard = num(d.debt_card);
  const debtOther = num(d.debt_other);
  const mortgageBalance = num(d.debt_mortgage);
  const nonHousingDebt = debtStudent + debtCar + debtCard + debtOther;
  const monthlyDebtPayment = (num(d.fx_student) || num(d.fx_scholarship))
    + num(d.fx_car_loan) + num(d.fx_card_loan) + num(d.fx_other_loan);
  const debtPaymentRate = annualIncome > 0 ? monthlyDebtPayment * 12 / annualIncome * 100 : 0;
  const scholarshipOnly = debtStudent > 0 && debtCar === 0 && debtCard === 0 && debtOther === 0;

  let debtCondition = '借入なし', debtMessage = '現在、住宅以外の借入はありません。', debtClass = 'eval-5';
  if (nonHousingDebt > 0 || mortgageBalance > 0) {
    if (debtCard > 0) {
      debtCondition = '高金利の借入を優先確認'; debtClass = 'eval-1';
      debtMessage = 'カードローン・リボは金利が高い場合があります。資産運用より先に、金利と返済計画の確認をおすすめします。';
    } else if (debtPaymentRate > 20) {
      debtCondition = '返済負担が大きめ'; debtClass = 'eval-1';
      debtMessage = '毎月の返済が手取り収入を圧迫している可能性があります。借換えや返済期間を含めた見直しをご検討ください。';
    } else if (debtPaymentRate > 10) {
      debtCondition = '返済と貯蓄のバランスに注意'; debtClass = 'eval-2';
      debtMessage = '返済を続けながら、生活防衛資金も確保できているか確認しましょう。';
    } else if (nonHousingDebt === 0 && mortgageBalance > 0) {
      debtCondition = '住宅ローン返済中'; debtClass = 'eval-3';
      debtMessage = '住宅ローンは対応する住宅資産があるため、金融資産の評価からは差し引いていません。毎月の住居費として家計収支に反映しています。';
    } else if (scholarshipOnly) {
      debtCondition = '奨学金を計画的に返済中'; debtClass = 'eval-4';
      debtMessage = '奨学金は教育のための借入として扱い、資産形成の評価からは差し引いていません。現在の返済負担は比較的抑えられています。';
    } else {
      debtCondition = '無理のない範囲で返済中'; debtClass = 'eval-4';
      debtMessage = '借入残高だけで悪く評価せず、毎月の返済負担を中心に確認しています。';
    }
  }

  // --- 総合判定 ------------------------------------------------------------
  const totalScore = (score1 + score2 + score3 + score4) / 4;
  let typeName = '', msg = '', badgeColor = '';

  if (totalScore >= 4.5) {
    typeName   = '🏅 殿堂入り！4つの力が備わった最強家計';
    badgeColor = 'linear-gradient(135deg, #059669 0%, #047857 100%)';
    msg        = '無駄な支出がなく、「残す力」と「働かせる力」が最高レベルで発揮されています！今のペースを維持できれば完璧です。さらなる高みを目指して資産の最適化を図りましょう。';
  } else if (totalScore >= 3.5) {
    typeName   = '💪 基礎力高め！引き締まった優良家計';
    badgeColor = 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)';
    msg        = '日々の節制ができており、お金を「残す力」がしっかり備わった良い家計状態です。素晴らしいですね！あとはお金を「働かせる力（運用）」を少し強化すると、さらに盤石になります。';
  } else if (totalScore >= 2.5) {
    typeName   = '🏃 伸びしろ十分！標準的な家計';
    badgeColor = 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)';
    msg        = '大きな問題はありませんが、将来に向けてさらに「育てる力」を伸ばしていきたい状態です。まずは無理のない範囲で、固定費を下げて「残す力」を高めるところから始めましょう！';
  } else if (totalScore >= 1.5) {
    typeName   = '🛋️ 要注意！力が眠っている家計';
    badgeColor = 'linear-gradient(135deg, #ea580c 0%, #c2410c 100%)';
    msg        = '少しずつ無駄な支出（ラテマネーやサブスク等）が蓄積し、お金を「残す力」が低下している状態です。少しずつ家計の改善が必要です！まずは現状の支出を把握し、整理していきましょう。';
  } else {
    typeName   = '⚠️ 赤信号！基礎力改善が急務な家計';
    badgeColor = 'linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)';
    msg        = '収入に対して支出が多く、早急な家計の見直しが必要な状態です。まずは止血（赤字解消）して「残す力」を取り戻し、防衛資金（現金）を貯める基礎固めから伴走します！';
  }

  const r1 = v => Math.round(Math.max(0, v) * 10) / 10;

  return {
    monthlyFixed:     monthlyFixed,
    monthlyVar:       monthlyVar,
    monthlyTotalExp:  monthlyTotalExp,
    annualTotalExp:   annualTotalExp,
    monthlySavings:   monthlySavings,
    annualSavings:    annualSavings,

    conversionRate:   r1(conversionRate),

    // ①の前提（賃金カーブによる累計収入の推計）
    lifetimeIncome:   lifetimeIncome,
    careerYears:      career.years,
    careerStartAge:   career.startAge,
    wageSource:       WAGE_SOURCE,

    efficiencyRate:   r1(efficiencyRate),
    fireProgressRate: r1(fireProgressRate),

    // ②の前提（同年代・同世帯類型との比較）
    peerPercentile:  peerRank.top,
    peerCapped:      peerRank.capped,
    peerGroupLabel:  peerGroupLabel,
    peerN:           peerDist.n,
    peerMedian:      peerDist.median,
    peerMean:        peerDist.mean,
    peerSource:      PEER_SOURCE,
    comparedAssets:  totalAssets,

    // ④の前提（結果画面に表示して根拠を示すため返す）
    assumedPensionMonthly:  pension.monthly,
    assumedPensionAnnual:   pension.annual,
    pensionBasis:           pension.basis,
    pensionSource:          pension.source,
    requiredAssetsForFire:  requiredAssetsForFire,
    pensionCoversExpenses:  pensionCoversExpenses,
    statsUpdated:           STATS_UPDATED,

    // ④の前提（老後の支出の推計）
    retireMonthlyExp:   retire.monthly,
    retireAnnualExp:    retire.annual,
    retireDropped:      retire.dropped,
    retireCut:          retire.cut,
    retireMedicalUp:    retire.medicalUplift,
    requiredFloor:      requiredFloor,
    floorApplied:       floorApplied,
    elderlyRefDeficit:  retire.refDeficit,
    elderlyRefLabel:    retire.refLabel,
    elderlyRefExp:      retire.refConsumption,
    elderlySource:      ELDERLY_SOURCE,

    // ③の内訳（運用に回っている資産）
    operationalAssets:  operationalAssets,
    livingDefenseFund:  livingDefenseFund,

    // 借入・返済コンディション（総合点には含めない）
    nonHousingDebt:     nonHousingDebt,
    mortgageBalance:   mortgageBalance,
    monthlyDebtPayment: monthlyDebtPayment,
    debtPaymentRate:   r1(debtPaymentRate),
    debtCondition:     debtCondition,
    debtMessage:       debtMessage,
    debtClass:         debtClass,

    score1: score1, text1: text1, class1: class1,
    score2: score2, text2: text2, class2: class2,
    score3: score3, text3: text3, class3: class3,
    score4: score4, text4: text4, class4: class4,

    totalScore: Math.round(totalScore * 100) / 100,
    typeName:   typeName,
    msg:        msg,
    badgeColor: badgeColor
  };
}


// ==========================================================
// スプレッドシートへの記録
// ==========================================================

function appendRow(body, d, r) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);   // 同時アクセスで行が壊れるのを防ぐ
  try {
    const sh = getSheet();

    const rec = {};
    Object.keys(d).forEach(k => { rec[k] = d[k]; });
    Object.keys(r).forEach(k => { rec[k] = r[k]; });

    rec.ts             = new Date();
    rec.sessionId      = body.sessionId || '';
    rec.staff          = body.staff || '';
    rec.source         = body.source || '';
    rec.appVersion     = body.appVersion || '';
    rec.consentVersion = body.consentVersion || '';
    rec.consentedAt    = body.consentedAt || '';
    rec.otherItems     = (d.otherItems || [])
      .map(x => x.label + ':' + x.val).join(' / ');

    const rowValues = COLS.map(k => (rec[k] === undefined || rec[k] === null) ? '' : rec[k]);
    // 同じ画面で入力を修正した場合は、同一回答を更新して重複集計を防ぐ。
    if (rec.sessionId && rec.consentedAt && sh.getLastRow() > 1) {
      const matches = sh.getRange(2, 7, sh.getLastRow() - 1, 1)
        .createTextFinder(rec.consentedAt).matchEntireCell(true).findAll();
      for (const match of matches) {
        const row = match.getRow();
        if (sh.getRange(row, 2).getValue() === rec.sessionId) {
          sh.getRange(row, 1, 1, COLS.length).setValues([rowValues]);
          return;
        }
      }
    }
    sh.appendRow(rowValues);
  } finally {
    lock.releaseLock();
  }
}

function getSheet() {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  let sh = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sh) sh = ss.insertSheet(CONFIG.SHEET_NAME);

  if (sh.getLastRow() === 0) {
    sh.appendRow(COLS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, COLS.length)
      .setFontWeight('bold')
      .setBackground('#e2e8f0');
  } else {
    // 既存シートへ末尾列を追加した場合、空いている見出しだけを自動補完する。
    // 既存の列名やデータは上書きしない。
    const headers = sh.getRange(1, 1, 1, COLS.length).getValues()[0];
    let headerChanged = false;
    for (let i = 0; i < COLS.length; i++) {
      if (headers[i] === '' || headers[i] === null) {
        headers[i] = COLS[i];
        headerChanged = true;
      }
    }
    if (headerChanged) {
      sh.getRange(1, 1, 1, COLS.length).setValues([headers]);
      sh.getRange(1, 1, 1, COLS.length)
        .setFontWeight('bold')
        .setBackground('#e2e8f0');
    }
  }
  return sh;
}


// ==========================================================
// 動作確認用（GASエディタから直接実行してください）
// ==========================================================

/** ダミーデータで1件記録し、シートへの書き込みと判定を確認する */
function testAppend() {
  const dummy = {
    user_age: 38, gender: '男性', pref: '東京都',
    household: '夫婦＋子ども', children: '2人', youngest_child_age: 5,
    housing: '賃貸', employment: '会社員', dual_income: '共働き',
    topics: '教育費 / 老後資金', working_years: 15,
    inc_gross: 450000, inc_net: 350000, bonus_count: 2, bonus_total: 900000,
    annualIncome: 5100000,
    ast_ordinary: 2000000, ast_time: 1000000, ast_other: 1500000,
    totalAssets: 4500000, debt_total: 500000, netWorth: 4000000,
    monthlyFixed: 180000, monthlyVar: 120000,
    otherItems: [{ label: 'サブスク', val: 3000 }]
  };
  const r = judge(dummy);
  appendRow({ sessionId: 'test', staff: 'test', source: 'test',
              appVersion: 'test', consentVersion: 'test',
              consentedAt: new Date().toISOString() }, dummy, r);
  Logger.log(JSON.stringify(r, null, 2));
}
