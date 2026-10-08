/**
 * AI 危機管理アセスメント ― 受信・判定・記録
 *
 * このファイルが「診断ロジックの本体」です。
 * 配点・ランクの閾値・12タイプの文言はすべてここにあり、ブラウザ側からは見えません。
 * 判定基準を変えたいときは「判定ロジック」以下を編集してください。
 *
 * === 導入手順（詳しくは deploy/導入手順.md）===
 *  1. 記録用のスプレッドシートを新規作成し、「拡張機能 → Apps Script」を開く
 *  2. このファイルの内容をすべて貼り付け、CONFIG.TOKEN に合言葉を設定
 *     （index.html 側の CONFIG.token と同じ値にする）
 *  3. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *       次のユーザーとして実行 : 自分
 *       アクセスできるユーザー : 全員
 *  4. 発行されたウェブアプリURLを index.html の CONFIG.endpoint に貼り付ける
 *
 *  ※ ロジックを修正したら、必ず「デプロイを管理」→ 鉛筆アイコン →
 *     バージョン「新バージョン」で再デプロイしてください（URLは変わりません）。
 */

const CONFIG = {
  SHEET_ID:   '',            // 空のままなら、このスクリプトを作成したスプレッドシートに記録する
  SHEET_NAME: 'responses',
  TOKEN:      'test',        // index.html の CONFIG.token と一致させること

  // ★ スプレッドシートへの記録のスイッチ。
  //    false … 判定結果だけ返し、1行も書き込まない（専用サーバーへ移すまではこちら）
  //    true  … 従来どおり responses シートに1件1行で記録する
  RECORD:     false
};

/**
 * スプレッドシートの列順と見出し。
 * 末尾への追加は安全。並べ替え・削除は既存データとズレるので注意。
 * 設問の列には点数（はい=2／少し不安=1／いいえ=0）が入ります。
 */
const COLS = [
  ['ts',             '日時'],
  ['sessionId',      'セッションID'],
  ['staff',          '担当者'],
  ['source',         '流入元'],
  ['appVersion',     'アプリ版'],
  ['consentVersion', '同意文面の版'],
  ['consentedAt',    '同意日時'],
  // --- 属性（採点には使わない）---
  ['age_band',       '年代'],
  ['gender',         '性別'],
  ['concern',        '一番不安なトラブル'],
  // --- 設問別の点数 ---
  ['a1', 'A1 自動払いの把握'],
  ['a2', 'A2 緊急用の貯金'],
  ['a3', 'A3 自己投資'],
  ['a4', 'A4 うまい儲け話への対処'],
  ['a5', 'A5 賠償リスクへの備え'],
  ['b1', 'B1 SOSを出せる居場所'],
  ['b2', 'B2 長期療養時のサポート'],
  ['b3', 'B3 健診・かかりつけ医'],
  ['b4', 'B4 トラブル時の相談先'],
  ['b5', 'B5 デジタルデトックス'],
  ['c1', 'C1 避難先・避難ルート'],
  ['c2', 'C2 備蓄の入れ替え'],
  ['c3', 'C3 安否確認の方法'],
  ['c4', 'C4 データのバックアップ'],
  ['c5', 'C5 パスワード・二段階認証'],
  // --- 判定 ---
  ['scoreA',         'お金・仕事（10点満点）'],
  ['scoreB',         '健康・メンタル（10点満点）'],
  ['scoreC',         '災害・デジタル（10点満点）'],
  ['totalScore',     '合計（30点満点）'],
  ['score100',       'スコア（100点換算）'],
  ['rank',           'ランク'],
  ['weakArea',       '最大の弱点'],
  ['typeName',       '診断タイプ'],
  ['durationSec',    '回答時間（秒）']
];


// ==========================================================
// 設問と選択肢（index.html と対応させること）
// ==========================================================

/** 年代・性別の選択肢。index.html の AGE_BANDS / GENDERS と同じ並び・同じ文字列にする。 */
const AGE_BANDS = ['19歳以下', '20〜24歳', '25〜29歳', '30〜34歳', '35〜39歳', '40代', '50代以上'];
const GENDERS   = ['男性', '女性', '回答しない'];

/** Q4（分岐）の選択肢 → 記録するラベル。並び順は index.html の CONCERN_OPTIONS と同じ。 */
const CONCERNS = ['お金・仕事', '情報・心身', '環境・災害'];

/** ジャンルごとの設問ID（各5問・10点満点）。index.html の QUESTIONS の id と対応。 */
const AREAS = {
  A: { label: 'お金・仕事・契約',     ids: ['a1', 'a2', 'a3', 'a4', 'a5'] },
  B: { label: '健康・メンタル・対人', ids: ['b1', 'b2', 'b3', 'b4', 'b5'] },
  C: { label: '災害・環境・デジタル', ids: ['c1', 'c2', 'c3', 'c4', 'c5'] }
};
const AREA_KEYS = ['A', 'B', 'C'];

/** 選択肢の並び（0:はい／1:少し不安／2:いいえ）→ 点数 */
const CHOICE_SCORE = [2, 1, 0];
const MAX_SCORE = 30;


// ==========================================================
// 判定基準（ここが非公開部分）
// ==========================================================

/** 合計点（30点満点）→ ランク。上から順に判定する。 */
const RANKS = [
  { rank: 'S', min: 25, name: '危機管理マスター：非常に高い防衛力を誇ります' },
  { rank: 'A', min: 19, name: '優秀な防衛者：基本は万全、あと一歩です' },
  { rank: 'B', min: 12, name: '平均的な市民：一部に大きなリスクが潜んでいます' },
  { rank: 'C', min: 0,  name: '危機管理レッドゾーン：早急な対策が必要です' }
];

/** ランク × 弱点ジャンルの12タイプ */
const RESULTS = {
  S: {
    A: {
      title: '【要塞の盲点】 隙を見せないタカ',
      msg: '全体的な危機管理能力は極めて高いですが、有事の際の「資金繰り」や契約関連にわずかな死角があります。緊急時のキャッシュフローだけ再確認しましょう。',
      concept: 'タカは高い視座から全体を見渡し、守りに隙がありません。しかし、狙った獲物（目先の利益や契約）に集中するあまり、足元のお金という一箇所の致命的な盲点（細かい契約の罠や、有事の資金繰り）を見落としてしまう危険性を表現しています。',
      magicQ: '自分なりに備えているつもりですが、プロの目から見て私の資金繰りや保険に抜け漏れはありませんか？'
    },
    B: {
      title: '【限界突破リスク】 無敵の鋼サイ',
      msg: '非常に堅牢な防衛力を誇りますが、自分自身の「心身の限界」を見落としがちです。いざという時に人に頼るルートや、休養の仕組み化を意識してください。',
      concept: 'サイは分厚い皮膚と強靭な肉体（防御力）を持っています。その高い防衛力を自分自身で過信しているため、知らず知らずのうちにストレスや疲労を溜め込み、限界を超えて突然倒れてしまうリスクを表現しています。',
      magicQ: '万が一、私が病気やメンタル不調で長期的に働けなくなった場合、今の公的制度や保険でどこまでカバーできますか？'
    },
    C: {
      title: '【不可抗力の脅威】 備え万全なビーバー',
      msg: 'あらゆるリスクを想定できていますが、住環境や大災害、デジタル乗っ取りなど「物理・環境的な脅威」への備えが唯一の弱点です。情報のバックアップと備蓄を再点検しましょう。',
      concept: 'ビーバーは自ら立派なダム（生活基盤）を築く勤勉で計画的な動物です。どれだけ個人で完璧な備えをしていても、大自然の猛威（災害）や外敵の侵入（デジタル乗っ取り）など、個人の努力だけでは防ぎきれない外的要因への対策の薄さを表現しています。',
      magicQ: '災害時の備えはしているものの、自宅が被害に遭った際の金銭的ダメージに対する備えが不安です。どう対処すべきですか？'
    }
  },
  A: {
    A: {
      title: '【短期決戦型】 逃げ足の速いチーター',
      msg: 'フットワークは軽いですが、万が一の収入減に対する金銭的クッションが不足気味です。生活防衛資金の確保を急ぎましょう。',
      concept: 'チーターは速く身軽で、目の前のトラブルを避ける瞬発力があります。しかし持久力がないため、ひとたび収入減や長期の療養といった「長期戦」に持ち込まれると、たちまち金銭的に息切れしてしまう危うさを表現しています。',
      magicQ: '知識はあるんですが、何から手をつければいいか迷っています。今の私の収入と固定費のバランス、プロから見て適正ですか？'
    },
    B: {
      title: '【自己犠牲リスク】 働き者のミツバチ',
      msg: '日常のタスク処理は優秀ですが、病気やメンタル不調時のセーフティネットが弱点です。かかりつけ医や相談先を確保してください。',
      concept: 'ミツバチは集団や家族のために一生懸命働き続ける優秀な存在です。しかし、周りのために動きすぎて自分自身を後回しにするため、過労やストレスに対するセーフティネット（相談相手や休養）がなく、突然飛べなくなってしまうリスクを表しています。',
      magicQ: '頭では分かっているのですが行動できていません。まずは最低限やっておくべき、私のライフスタイルに合ったリスク対策を教えてください。'
    },
    C: {
      title: '【日常優先の死角】 おっとりアルパカ',
      msg: '日常のトラブル回避は上手ですが、災害やネット詐欺など、外部からの突然の脅威に対する具体的なアクションが不足しています。初期対応の確認をしましょう。',
      concept: 'アルパカは穏やかで平和な日常を送っています。日常のトラブル回避は上手な反面、大地震などの自然災害や、悪質なネット詐欺といった「非日常の強烈な脅威」に対して、つい意識が後回し（おっとり）になり、初期対応が遅れてしまう死角を表現しています。',
      magicQ: '防災の知識はあるものの、面倒で実践できていません。手間をかけずに自動的に備えられるような良い仕組みやアイデアはありますか？'
    }
  },
  B: {
    A: {
      title: '【やりくり限界リスク】 綱渡りのサル',
      msg: '全体的な備えが平均的ですが、特にお金やキャリアの危機に対する防御力が低めです。まずは数ヶ月分の生活費の確保から始めましょう。',
      concept: 'サルのように持ち前の身軽さで、日々の家計のやりくりは何とか回っています。しかし、現状で手一杯なため、これ以上の突発的な出費や大きな経済的ダメージを受けると、一気にバランスを崩してしまう財務基盤の危うさを表現しています。',
      magicQ: '正直、何から備えればいいか全く分かりません！とりあえず今の私に一番足りない最低限のお金の備えを教えてもらえませんか？'
    },
    B: {
      title: '【孤軍奮闘リスク】 一匹狼のオオカミ',
      msg: '何でも一人で解決しようとする傾向があり、長期療養やメンタル不調時に行き詰まるリスクがあります。公的制度やサポート環境を知る事が急務です。',
      concept: '自立心が強く、何でも一人で解決しようと奮闘している状態です。しかし、周囲のサポート環境や公的制度への関心が薄いため、本当に自分が倒れてしまった瞬間に、頼れるルートが塞がってしまう孤立リスクを表しています。',
      magicQ: '日々忙しくて、リスク管理まで手が回っていません。私のような状況でも、プロに任せきりで防衛力を上げる方法はありますか？'
    },
    C: {
      title: '【後回しリスク】 楽観的なカンガルー',
      msg: 'トラブルが起きてから対処する傾向が強く、火災保険の未確認や備蓄不足、パスワードの使い回しなど、環境・情報リスクに弱いです。最低限の防衛設定を行いましょう。',
      concept: '「なんとかなるっしょ！」と元気に前へ跳んでいますが、お腹のポケット（備え）の中身が空っぽです。悪気はないものの、防災セットの準備、火災保険の確認、デジタルのセキュリティ設定などを、すべて「後回し」にしてしまっている無防備さを表現しています。',
      magicQ: '災害対策も保険も、全く手付かずで不安です。私のライフスタイルなら、まず何から始めるのが正解ですか？'
    }
  },
  C: {
    A: {
      title: '【家計基盤の見直し期】 頑張りすぎのラクダ',
      msg: '危機に対する備えが全体的に不足しており、特にお金や仕事のトラブルが大きな負担になりかねません。保険の見直しや固定費削減で、早急に安心できる防衛資金を作りましょう。',
      concept: '過酷な環境を必死に耐えて歩くラクダのように、現状の家計や仕事の負担を一人で抱え込み、限界まで頑張りすぎている状態です。今こそ立ち止まり、プロと一緒に保険や支出の土台を整えるべき「絶好の見直し期」であることを表しています。',
      magicQ: '行動力には自信があるのですが、将来のお金の備えに抜け漏れがないか心配です。今の私の年代で、絶対に知っておくべきお金の制度は何ですか？'
    },
    B: {
      title: '【エネルギー不足】 お疲れ気味のパンダ',
      msg: 'いつトラブルが起きてもおかしくない状態です。まずは何よりも自分自身の健康とメンタルのケアを最優先し、周りに頼れる環境を整えてください。',
      concept: '日々の生活や目の前のストレスに対応するだけで精一杯になり、心と体のエネルギーが完全に不足している状態です。不測の事態が起きたときに踏ん張る「余力」が残っていないため、まずは周囲に頼り、燃料を蓄えるべきだと労わるモチーフです。',
      magicQ: '日々忙しくて、リスク管理まで手が回っていません。もしもの時に一番頼りになる窓口や制度を事前に知っておきたいです。'
    },
    C: {
      title: '【準備不足のサバイバル】 迷えるペンギン',
      msg: '災害やデジタル詐欺に対する準備が不足しています。命や生活基盤を守るため、避難場所の確認とパスワード管理の見直しを今すぐ行い、備えを万全にしていきましょう。',
      concept: '大災害やデジタル詐欺などの大きな脅威に対して、何をどう備えればいいか分からず、情報の海で迷子になってしまっている状態です。丸腰で厳しい自然を生き抜くような危うさがあり、今すぐ具体的な「準備」を始める必要があることを伝えています。',
      magicQ: '災害対策も保険も、全く手付かずで不安です。一人暮らしの私なら、まず何から始めるのが正解ですか？'
    }
  }
};


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
    const invalid = validate(d);
    if (invalid) return json({ ok: false, error: invalid + ' の回答が正しくありません' });
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

/** 疎通確認用。ブラウザでウェブアプリURLを開くと {"ok":true,...} が出れば成功。 */
function doGet() {
  return json({ ok: true, msg: 'endpoint alive' });
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** 不正な回答があれば項目名を返す。問題なければ空文字。 */
function validate(d) {
  if (AGE_BANDS.indexOf(d.age_band) < 0) return '年代';
  if (GENDERS.indexOf(d.gender) < 0)     return '性別';
  if (!isChoice(d.concern, CONCERNS.length)) return 'Q4（一番不安なトラブル）';
  const answers = d.answers || {};
  for (const t of AREA_KEYS) {
    for (const id of AREAS[t].ids) {
      if (!isChoice(answers[id], CHOICE_SCORE.length)) return '設問 ' + id;
    }
  }
  return '';
}

function isChoice(v, count) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < count;
}


// ==========================================================
// 判定ロジック
// ==========================================================

function judge(d) {
  const answers = d.answers;

  // --- ジャンル別の点数（各5問 × 2点 = 10点満点）---
  const scores = {};
  let total = 0;
  AREA_KEYS.forEach(t => {
    scores[t] = AREAS[t].ids.reduce((sum, id) => sum + CHOICE_SCORE[answers[id]], 0);
    total += scores[t];
  });

  // --- 総合ランク（30点満点で判定）---
  const rank = RANKS.filter(r => total >= r.min)[0];

  // --- 最大の弱点 = 最も点数が低いジャンル。同点のときは A → B → C の順で優先 ---
  let weak = 'A';
  AREA_KEYS.forEach(t => { if (scores[t] < scores[weak]) weak = t; });

  const type = RESULTS[rank.rank][weak];

  return {
    scoreA:     scores.A,
    scoreB:     scores.B,
    scoreC:     scores.C,
    totalScore: total,
    score100:   Math.round(total / MAX_SCORE * 100),
    rank:       rank.rank,
    rankName:   rank.name,
    weakType:   weak,
    weakArea:   AREAS[weak].label,
    typeName:   type.title,
    msg:        type.msg,
    concept:    type.concept,
    magicQ:     type.magicQ
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

    const rec = {
      ts:             new Date(),
      sessionId:      body.sessionId || '',
      staff:          body.staff || '',
      source:         body.source || '',
      appVersion:     body.appVersion || '',
      consentVersion: body.consentVersion || '',
      consentedAt:    body.consentedAt || '',
      age_band:       d.age_band,
      gender:         d.gender,
      concern:        CONCERNS[d.concern],
      durationSec:    (Number.isFinite(Number(d.durationSec)) && Number(d.durationSec) >= 0)
                        ? Math.round(Number(d.durationSec)) : ''
    };
    AREA_KEYS.forEach(t => {
      AREAS[t].ids.forEach(id => { rec[id] = CHOICE_SCORE[d.answers[id]]; });
    });
    Object.keys(r).forEach(k => { if (rec[k] === undefined) rec[k] = r[k]; });

    const rowValues = COLS.map(c => (rec[c[0]] === undefined || rec[c[0]] === null) ? '' : rec[c[0]]);

    // 通信エラーで再送した場合などは、同じ回答の行を更新して重複集計を防ぐ。
    // 「最初からやり直す」は同意し直すため、別の回答として新しい行になる。
    const row = findSameResponse(sh, rec.sessionId, rec.consentedAt);
    if (row) {
      sh.getRange(row, 1, 1, COLS.length).setValues([rowValues]);
    } else {
      sh.appendRow(rowValues);
    }
  } finally {
    lock.releaseLock();
  }
}

/** セッションIDと同意日時が一致する行の番号を返す。なければ 0。 */
function findSameResponse(sh, sessionId, consentedAt) {
  if (!sessionId || !consentedAt || sh.getLastRow() < 2) return 0;
  const sidCol = colNumber('sessionId');
  const atCol  = colNumber('consentedAt');
  const hits = sh.getRange(2, sidCol, sh.getLastRow() - 1, 1)
    .createTextFinder(sessionId).matchEntireCell(true).findAll();
  for (let i = hits.length - 1; i >= 0; i--) {
    const row = hits[i].getRow();
    const v = sh.getRange(row, atCol).getValue();
    // 日時として解釈されて保存されていた場合にも一致を判定できるようにする
    const same = (v instanceof Date) ? v.getTime() === Date.parse(consentedAt)
                                     : String(v) === consentedAt;
    if (same) return row;
  }
  return 0;
}

function colNumber(key) {
  for (let i = 0; i < COLS.length; i++) if (COLS[i][0] === key) return i + 1;
  throw new Error('unknown column: ' + key);
}

function getSheet() {
  const ss = CONFIG.SHEET_ID
    ? SpreadsheetApp.openById(CONFIG.SHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('記録先が見つかりません。CONFIG.SHEET_ID にスプレッドシートIDを設定してください');

  let sh = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sh) sh = ss.insertSheet(CONFIG.SHEET_NAME);

  const headers = COLS.map(c => c[1]);
  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, COLS.length).setFontWeight('bold').setBackground('#efe7d4');
    // 同意日時は重複判定に使うため、日付に自動変換されないよう文字列として扱う
    sh.getRange(2, colNumber('consentedAt'), sh.getMaxRows() - 1, 1).setNumberFormat('@');
  } else {
    // 末尾に列を追加した場合、空いている見出しだけを自動補完する。
    // 既存の見出しやデータは上書きしない。
    const current = sh.getRange(1, 1, 1, COLS.length).getValues()[0];
    let changed = false;
    for (let i = 0; i < COLS.length; i++) {
      if (current[i] === '' || current[i] === null) { current[i] = headers[i]; changed = true; }
    }
    if (changed) {
      sh.getRange(1, 1, 1, COLS.length).setValues([current])
        .setFontWeight('bold').setBackground('#efe7d4');
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
    age_band: '25〜29歳', gender: '女性', concern: 1,
    answers: {
      a1: 0, a2: 1, a3: 0, a4: 0, a5: 2,
      b1: 1, b2: 2, b3: 1, b4: 2, b5: 1,
      c1: 0, c2: 1, c3: 0, c4: 0, c5: 1
    },
    durationSec: 150
  };
  const invalid = validate(dummy);
  if (invalid) throw new Error('dummy invalid: ' + invalid);
  const r = judge(dummy);
  appendRow({ sessionId: 'test', staff: 'test', source: 'test',
              appVersion: 'test', consentVersion: 'test',
              consentedAt: new Date().toISOString() }, dummy, r);
  Logger.log(JSON.stringify(r, null, 2));
}
