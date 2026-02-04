// ===== BEGIN main.mjs (PART 1/2) =====
import 'dotenv/config';
import express from 'express';
import {
  Client, GatewayIntentBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  SlashCommandBuilder, REST, Routes,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  EmbedBuilder, InteractionType, PermissionsBitField
} from 'discord.js';
import pkg from 'pg';
const { Pool } = pkg;

/* ==============================
   Express Web Server (Render 用)
============================== */
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));

/* ==============================
   Discord Bot 初期化
============================== */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

/* ==============================
   環境変数
============================== */
const COUNT_CHANNEL_ID = process.env.COUNT_CHANNEL_ID;
const NICKNAME_CHANNEL_ID = process.env.NICKNAME_CHANNEL_ID;
const AUTO_ROLE_ID = process.env.AUTO_ROLE_ID;

// ★ ファン数UI用チャンネル（単一）
const FANS_CHANNEL_ID = process.env.FANS_CHANNEL_ID || '1425079163005571132';
// 入力レート制限（秒）
const FANS_MIN_INTERVAL_SEC = parseInt(process.env.FANS_MIN_INTERVAL_SEC || '30', 10);
// 減少値を許可するか（通常入力）
const FANS_ALLOW_DECREASE = (process.env.FANS_ALLOW_DECREASE || 'false').toLowerCase() === 'true';
// ★ 訂正（last側）時は減少も許可するか（既定 true）
const FANS_EDIT_ALLOW_DECREASE = (process.env.FANS_EDIT_ALLOW_DECREASE || 'true').toLowerCase() === 'true';
// ★ 訂正（last側）はレート制限をバイパスするか（既定 true）
const FANS_EDIT_BYPASS_RATE = (process.env.FANS_EDIT_BYPASS_RATE || 'true').toLowerCase() === 'true';

// ★ ベース値訂正用の許可＆バイパス（今月の base_fans を上書き）
const FANS_BASE_EDIT_ALLOW_DECREASE = (process.env.FANS_BASE_EDIT_ALLOW_DECREASE || 'true').toLowerCase() === 'true';
const FANS_BASE_EDIT_BYPASS_RATE = (process.env.FANS_BASE_EDIT_BYPASS_RATE || 'true').toLowerCase() === 'true';

// ★ OCR（スクショ読み取り）設定
const FANS_OCR_ENABLED = (process.env.FANS_OCR_ENABLED || 'true').toLowerCase() === 'true';
const FANS_OCR_MIN_INTERVAL_SEC = parseInt(process.env.FANS_OCR_MIN_INTERVAL_SEC || '15', 10);
const FANS_OCR_PENDING_TTL_SEC = parseInt(process.env.FANS_OCR_PENDING_TTL_SEC || '600', 10); // 安全策（将来拡張用）

// 匿名投票の許可チャンネル（未指定ならどこでもOK、カンマ区切り）
const ANONPOLL_CHANNEL_IDS = (process.env.ANONPOLL_CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
// ★ 匿名投票：最大選択肢数（既定 10 / 最大25）
const ANONPOLL_MAX_OPTIONS = Math.min(parseInt(process.env.ANONPOLL_MAX_OPTIONS || '10', 10) || 10, 25); // Discordは1メッセ最大25ボタン（5x5行）に配慮

/* ==============================
   DB 接続
============================== */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  // 安定化/節約寄り（任意）
  max: parseInt(process.env.PG_POOL_MAX || '2', 10),
  idleTimeoutMillis: parseInt(process.env.PG_IDLE_TIMEOUT_MS || '10000', 10), // 10s
  connectionTimeoutMillis: parseInt(process.env.PG_CONN_TIMEOUT_MS || '5000', 10), // 5s
});

/* ==============================
   初回起動時に必要テーブルを作成/更新
============================== */
async function initDB() {
  // 既存：counts
  await pool.query(`
    CREATE TABLE IF NOT EXISTS counts (
      user_id BIGINT PRIMARY KEY,
      kiremono INTEGER DEFAULT 0,
      ritaiya INTEGER DEFAULT 0,
      kirenashi INTEGER DEFAULT 0,
      nickname_changes INTEGER DEFAULT 0
    )
  `);

  // 既存：ファン数
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fan_snapshots (
      guild_id TEXT NOT NULL,
      user_id  TEXT NOT NULL,
      snapshot_ts TIMESTAMPTZ NOT NULL DEFAULT now(),
      fans_total BIGINT NOT NULL CHECK (fans_total >= 0),
      source   TEXT NOT NULL DEFAULT 'manual',
      note     TEXT,
      PRIMARY KEY (guild_id, user_id, snapshot_ts)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_fan_snapshots_lookup
      ON fan_snapshots (guild_id, user_id, snapshot_ts DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fan_monthly (
      guild_id  TEXT NOT NULL,
      user_id   TEXT NOT NULL,
      month_key TEXT NOT NULL,  -- 'YYYY-MM' (JST基準)
      base_fans BIGINT NOT NULL,
      last_fans BIGINT NOT NULL,
      delta_fans BIGINT NOT NULL,
      updates   INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (guild_id, user_id, month_key)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_fan_monthly_lookup
      ON fan_monthly (guild_id, user_id, month_key)
  `);

  // 既存：匿名投票
  await pool.query(`
    CREATE TABLE IF NOT EXISTS anon_polls (
      poll_id      TEXT PRIMARY KEY,   -- message_id を使う
      guild_id     TEXT NOT NULL,
      channel_id   TEXT NOT NULL,
      question     TEXT NOT NULL,
      options      TEXT[] NOT NULL,
      is_closed    BOOLEAN NOT NULL DEFAULT FALSE,
      created_by   TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // multi_allowed 追加（なければ）
  await pool.query(`ALTER TABLE anon_polls ADD COLUMN IF NOT EXISTS multi_allowed BOOLEAN NOT NULL DEFAULT FALSE`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS anon_votes (
      poll_id   TEXT NOT NULL,
      user_id   TEXT NOT NULL,
      choice    INT  NOT NULL,
      voted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // 旧PK -> 新形式 (poll_id,user_id,choice)
  await pool.query(`DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_name='anon_votes' AND constraint_type='PRIMARY KEY' AND constraint_name='anon_votes_pkey'
    ) THEN
      BEGIN
        ALTER TABLE anon_votes DROP CONSTRAINT anon_votes_pkey;
      EXCEPTION WHEN undefined_object THEN
      END;
    END IF;
  END $$;`);
  await pool.query(`ALTER TABLE anon_votes ADD CONSTRAINT anon_votes_pkey PRIMARY KEY (poll_id, user_id, choice)`);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name='anon_votes' AND constraint_name='anon_votes_poll_id_fkey'
      ) THEN
        ALTER TABLE anon_votes
          ADD CONSTRAINT anon_votes_poll_id_fkey
          FOREIGN KEY (poll_id) REFERENCES anon_polls(poll_id) ON DELETE CASCADE;
      END IF;
    END $$;
  `);

  // ★追加：ニックネ変更前の「サーバーニックネーム」退避（DB保存）
  // old_nick は NULL 許容（＝サーバーニックなし → setNickname(null) で復元）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nickname_backups (
      guild_id TEXT NOT NULL,
      user_id  TEXT NOT NULL,
      old_nick TEXT,
      saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (guild_id, user_id)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_nickname_backups_saved_at
      ON nickname_backups (saved_at DESC)
  `);
}

/* ==============================
   共通ユーティリティ
============================== */
const WORD_BUTTONS = ['kiremono', 'ritaiya', 'kirenashi'];
const BUTTON_LABELS = { kiremono: 'きれもの', ritaiya: 'りたいあ', kirenashi: 'きれなし' };
const randomReplies = [
  '窓をお開け！全部だよ！！',
  'やはり！さぁ、きばるんだよ！',
  'んん……？？',
  'あぁああごめんごめん、いい子でおねんねしてたのにねぇ。',
  'ヒッ！？ ',
  'うるさいね、静かにしておくれ。',
  'だァーーーまァーーーれェーーー！！！',
  '大きな声を出すんじゃない……うっ！あー、ちょっと待ちなさい、ね、ねぇ～。',
  '四の五の言うと、石炭にしちまうよ。わかったね！',
  'なぁんだいおまえ。生きてたのかい。',
  'ずいぶん生意気な口を利くね。いつからそんなに偉くなったんだい？',
  'フン！',
];

// ニックネーム遊びの「変更後」判定
const KIREMONO_NICK_RE = /^切れ者確率\d+%$/;

// JSTのYYYY-MMキー
function getJstMonthKey(date = new Date()) {
  const d = new Date(date.getTime() + 9 * 60 * 60 * 1000); // JST補正
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// レート制限メモ（ユーザーごと）
const fansLastInputAt = new Map();
// OCR実行レート制限
const fansOcrLastRunAt = new Map();

/* ==============================
   Interaction 安全化（3秒制限対策）
============================== */
function isLikelyDbPausedError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return (
    msg.includes('paused') ||
    (msg.includes('free') && msg.includes('limit')) ||
    (msg.includes('monthly') && msg.includes('limit')) ||
    msg.includes('terminating connection') ||
    msg.includes('connection terminated') ||
    msg.includes('remaining connection slots') ||
    msg.includes('timeout') ||
    msg.includes('etimedout')
  );
}
function dbPausedUserMessage() {
  return 'DBが停止中/制限到達の可能性があります（Neonの月次上限など）。時間を置くか、DB側の制限を解除してください。';
}

// ★修正ポイント：editReplyに ephemeral を渡さない
async function safeReplyOrEdit(interaction, payload) {
  if (interaction.deferred || interaction.replied) {
    if (typeof payload === 'string') return interaction.editReply(payload);
    const p = { ...payload };
    delete p.ephemeral; // editReplyではephemeralは使えない
    return interaction.editReply(p);
  }
  return interaction.reply(payload);
}
async function safeDeferReply(interaction, ephemeral = true) {
  if (interaction.deferred || interaction.replied) return;
  await interaction.deferReply({ ephemeral }).catch(() => {});
}

/* ==============================
   追加：ファン数モーダルのプレフィルキャッシュ
============================== */
const fansLastSnapshotCache = new Map(); // `${guildId}:${userId}` -> number
const fansMonthBaseCache = new Map();    // `${guildId}:${userId}:${monthKey}` -> number
function keyGU(guildId, userId) { return `${guildId}:${userId}`; }
function keyGUM(guildId, userId, monthKey) { return `${guildId}:${userId}:${monthKey}`; }

/* ==============================
   ★追加：OCR（スクショから総獲得数を読む）
   - 依存：tesseract.js, sharp（どちらも動的import）
   - 起動時には読み込まない（OCR実行時にだけロード）
============================== */
let _ocrWorkerPromise = null;
let _ocrQueue = Promise.resolve();

function queueOcr(taskFn) {
  const next = _ocrQueue.then(taskFn, taskFn);
  _ocrQueue = next.catch(() => {});
  return next;
}

async function getOcrWorkerEng() {
  if (_ocrWorkerPromise) return _ocrWorkerPromise;

  _ocrWorkerPromise = (async () => {
    const mod = await import('tesseract.js');
    const createWorker = mod.createWorker || mod.default?.createWorker;
    if (!createWorker) throw new Error('tesseract.js の createWorker が見つかりません');

    const worker = await createWorker({ logger: () => {} }); // noisyログを抑制
    await worker.loadLanguage('eng');
    await worker.initialize('eng');
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789,',
      preserve_interword_spaces: '1',
    });
    return worker;
  })();

  return _ocrWorkerPromise;
}

async function preprocessAndOcrNumberFromBuffer(imageBuf) {
  const sharpMod = await import('sharp');
  const sharp = sharpMod.default || sharpMod;

  const img = sharp(imageBuf, { failOnError: false });
  const meta = await img.metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;
  if (!w || !h) throw new Error('画像サイズが取得できません');

  // 画面右下に寄せてクロップ（端末差を考慮し広め）
  const crop = {
    left: Math.max(0, Math.floor(w * 0.40)),
    top: Math.max(0, Math.floor(h * 0.70)),
    width: Math.min(w, Math.floor(w * 0.60)),
    height: Math.min(h - Math.floor(h * 0.70), Math.floor(h * 0.22)),
  };

  const region = await img
    .extract(crop)
    .resize({ width: Math.max(800, Math.floor(crop.width * 2)) })
    .grayscale()
    .normalize()
    .threshold(180)
    .toBuffer();

  const worker = await getOcrWorkerEng();
  const { data } = await worker.recognize(region);
  const text = String(data?.text || '');

  // 数字（カンマ区切り）候補抽出。最長候補を採用
  const matches = [...text.matchAll(/(\d[\d,]{4,})/g)].map(m => m[1]).filter(Boolean);
  if (!matches.length) return { value: null, rawText: text };

  matches.sort((a, b) => (b.replace(/,/g, '').length - a.replace(/,/g, '').length));
  const picked = matches[0];
  const digits = picked.replace(/,/g, '');
  if (!/^\d+$/.test(digits)) return { value: null, rawText: text };

  const bi = BigInt(digits);
  if (bi > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { value: null, rawText: text, tooLarge: true };
  }

  return { value: Number(bi), rawText: text };
}

async function ocrFansTotalFromAttachment(attachment) {
  if (!attachment?.url) throw new Error('添付URLが取得できません');
  const ct = String(attachment.contentType || '');
  const name = String(attachment.name || '');

  const looksImage =
    ct.startsWith('image/') ||
    /\.(png|jpg|jpeg|webp|bmp)$/i.test(name);

  if (!looksImage) {
    throw new Error('画像ファイルではない可能性があります（png/jpg/webp推奨）');
  }

  // Node18+ は fetch がグローバル
  if (typeof fetch !== 'function') {
    throw new Error('この実行環境は fetch をサポートしていません（Node18+推奨）');
  }

  const res = await fetch(attachment.url);
  if (!res.ok) throw new Error(`画像の取得に失敗しました（HTTP ${res.status}）`);
  const buf = Buffer.from(await res.arrayBuffer());

  return queueOcr(async () => {
    const out = await preprocessAndOcrNumberFromBuffer(buf);
    return out;
  });
}

/* ==============================
   DB ヘルパー（既存）
============================== */
async function loadCount(userId) {
  const { rows } = await pool.query('SELECT * FROM counts WHERE user_id=$1', [userId]);
  if (!rows.length) return { kiremono: 0, ritaiya: 0, kirenashi: 0, nickname_changes: 0 };
  return rows[0];
}
async function saveCount(userId, counts) {
  await pool.query(`
    INSERT INTO counts(user_id,kiremono,ritaiya,kirenashi,nickname_changes)
    VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(user_id) DO UPDATE
    SET kiremono=$2, ritaiya=$3, kirenashi=$4, nickname_changes=$5
  `, [userId, counts.kiremono, counts.ritaiya, counts.kirenashi, counts.nickname_changes]);
}
async function resetAllCounts() {
  await pool.query('UPDATE counts SET kiremono=0, ritaiya=0, kirenashi=0');
}

/* ==============================
   ★追加：ニックネーム退避（DB保存）
============================== */
async function upsertNicknameBackup(guildId, userId, oldNick /* string|null */) {
  await pool.query(
    `
    INSERT INTO nickname_backups (guild_id, user_id, old_nick)
    VALUES ($1, $2, $3)
    ON CONFLICT (guild_id, user_id) DO UPDATE
      SET old_nick = EXCLUDED.old_nick,
          saved_at = now()
    `,
    [String(guildId), String(userId), oldNick === undefined ? null : oldNick]
  );
}
async function fetchNicknameBackup(guildId, userId) {
  const { rows } = await pool.query(
    `SELECT old_nick FROM nickname_backups WHERE guild_id=$1 AND user_id=$2`,
    [String(guildId), String(userId)]
  );
  if (!rows.length) return { exists: false, oldNick: null };
  return { exists: true, oldNick: rows[0].old_nick === null ? null : String(rows[0].old_nick) };
}
async function deleteNicknameBackup(guildId, userId) {
  await pool.query(
    `DELETE FROM nickname_backups WHERE guild_id=$1 AND user_id=$2`,
    [String(guildId), String(userId)]
  );
}

/* ==============================
   ボタン管理（既存）
============================== */
const userButtonMessages = new Map();
function createButtonRow(userCounts) {
  const row = new ActionRowBuilder();
  WORD_BUTTONS.forEach(key => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(key)
        .setLabel(`${BUTTON_LABELS[key]} ${userCounts[key] || 0}回`)
        .setStyle(ButtonStyle.Primary)
    );
  });
  return row;
}
async function sendOrUpdateButtons(channel, userId, userCounts) {
  const row = createButtonRow(userCounts);
  if (userButtonMessages.has(userId)) {
    await userButtonMessages.get(userId).edit({ content: '集計ボタン', components: [row] });
  } else {
    const msg = await channel.send({ content: '集計ボタン', components: [row] });
    userButtonMessages.set(userId, msg);
  }
}

/* ==============================
   ファン数：UIコンポーネント
============================== */
function fansPanel() {
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle('📈 ウマ娘 ファン数トラッキング（JST）')
        .setDescription(
          '月初にベース値を登録し、月途中で最新の**累計ファン数**を入れると今月の増分が分かります。\n' +
          'スクショからの読み取りは **/fans ocr** を使ってください（進行状況 → ファン → 総獲得数 が写っている画像）。'
        )
        .setFooter({ text: '入力は本人にのみ見える形で返信します（ephemeral）' })
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('fans:set').setLabel('現在の累計ファン数を入力').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('fans:ocr').setLabel('スクショから読み取る').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('fans:my').setLabel('自分の記録を見る').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('fans:edit').setLabel('前回入力を訂正（最新値）').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('fans:base').setLabel('ベース値を訂正（今月）').setStyle(ButtonStyle.Secondary)
      )
    ]
  };
}
function fansModal(currentValue = '') {
  return new ModalBuilder()
    .setCustomId('fans:modal')
    .setTitle('現在の累計ファン数を入力')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('fans:value')
          .setLabel('累計ファン数（整数）')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('例: 1234567')
          .setRequired(true)
          .setValue(currentValue)
      )
    );
}
function fansEditModal(prevValue = '') {
  return new ModalBuilder()
    .setCustomId('fans:modal_edit')
    .setTitle('訂正：累計ファン数（最新値）')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('fans:value_edit')
          .setLabel('訂正後の累計ファン数（整数）')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('例: 1234567')
          .setRequired(true)
          .setValue(prevValue)
      )
    );
}
function fansBaseModal(prevBase = '') {
  return new ModalBuilder()
    .setCustomId('fans:modal_base')
    .setTitle('ベース値を訂正（今月）')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('fans:value_base')
          .setLabel('ベース値（整数 / 今月の基準）')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('例: 2446076025')
          .setRequired(true)
          .setValue(prevBase)
      )
    );
}

// ★OCR結果の修正用モーダル
function fansOcrFixModal(defaultValue = '', mode = 'set') {
  const title = mode === 'edit' ? 'OCR修正：訂正（最新値）' : 'OCR修正：登録（通常）';
  return new ModalBuilder()
    .setCustomId(`fans:ocr:modal_fix:${mode}:${defaultValue || ''}`)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('fans:ocr_value_fix')
          .setLabel('累計ファン数（整数）')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('例: 5900831246')
          .setRequired(true)
          .setValue(defaultValue || '')
      )
    );
}

/* ==============================
   ファン数：ロジック
============================== */
async function insertSnapshotAndUpsertMonthly(guildId, userId, value, source = 'manual') {
  await pool.query(
    `INSERT INTO fan_snapshots (guild_id, user_id, fans_total, source) VALUES ($1,$2,$3,$4)`,
    [guildId, userId, value, source]
  );

  fansLastSnapshotCache.set(keyGU(guildId, userId), Number(value));

  const monthKey = getJstMonthKey();
  const { rows } = await pool.query(
    `SELECT base_fans, last_fans, updates FROM fan_monthly WHERE guild_id=$1 AND user_id=$2 AND month_key=$3`,
    [guildId, userId, monthKey]
  );

  if (!rows.length) {
    await pool.query(
      `INSERT INTO fan_monthly (guild_id,user_id,month_key,base_fans,last_fans,delta_fans,updates)
       VALUES ($1,$2,$3,$4,$4,0,1)`,
      [guildId, userId, monthKey, value]
    );

    fansMonthBaseCache.set(keyGUM(guildId, userId, monthKey), Number(value));

    return { monthKey, base: value, last: value, delta: 0, updates: 1 };
  } else {
    const base = Number(rows[0].base_fans);
    const updates = Number(rows[0].updates) + 1;
    const last = value;
    const delta = Math.max(0, Number(last) - Number(base));

    await pool.query(
      `UPDATE fan_monthly
       SET last_fans=$4, delta_fans=$5, updates=$6, updated_at=now()
       WHERE guild_id=$1 AND user_id=$2 AND month_key=$3`,
      [guildId, userId, monthKey, last, delta, updates]
    );

    fansMonthBaseCache.set(keyGUM(guildId, userId, monthKey), Number(base));

    return { monthKey, base, last, delta, updates };
  }
}

async function fetchMyMonth(guildId, userId, monthKey = getJstMonthKey()) {
  const { rows } = await pool.query(
    `SELECT base_fans,last_fans,delta_fans,updates,updated_at
     FROM fan_monthly WHERE guild_id=$1 AND user_id=$2 AND month_key=$3`,
    [guildId, userId, monthKey]
  );
  if (!rows.length) return null;

  const r = rows[0];
  fansMonthBaseCache.set(keyGUM(guildId, userId, monthKey), Number(r.base_fans));

  return {
    monthKey,
    base: Number(r.base_fans),
    last: Number(r.last_fans),
    delta: Number(r.delta_fans),
    updates: Number(r.updates),
    updatedAt: r.updated_at
  };
}

async function fetchLastSnapshotValue(guildId, userId) {
  const cached = fansLastSnapshotCache.get(keyGU(guildId, userId));
  if (typeof cached === 'number') return cached;

  const { rows } = await pool.query(
    `SELECT fans_total FROM fan_snapshots WHERE guild_id=$1 AND user_id=$2 ORDER BY snapshot_ts DESC LIMIT 1`,
    [guildId, userId]
  );
  const v = rows.length ? Number(rows[0].fans_total) : null;
  if (v !== null) fansLastSnapshotCache.set(keyGU(guildId, userId), Number(v));
  return v;
}

async function correctBaseFans(guildId, userId, newBase) {
  const monthKey = getJstMonthKey();
  const { rows } = await pool.query(
    `SELECT base_fans,last_fans,updates FROM fan_monthly WHERE guild_id=$1 AND user_id=$2 AND month_key=$3`,
    [guildId, userId, monthKey]
  );

  if (!rows.length) {
    await pool.query(
      `INSERT INTO fan_monthly (guild_id,user_id,month_key,base_fans,last_fans,delta_fans,updates)
       VALUES ($1,$2,$3,$4,$4,0,1)`,
      [guildId, userId, monthKey, newBase]
    );

    fansMonthBaseCache.set(keyGUM(guildId, userId, monthKey), Number(newBase));

    return { monthKey, base: newBase, last: newBase, delta: 0, updates: 1 };
  } else {
    const last = Number(rows[0].last_fans);
    const updates = Number(rows[0].updates) + 1;
    const delta = Math.max(0, Number(last) - Number(newBase));

    await pool.query(
      `UPDATE fan_monthly
       SET base_fans=$4, delta_fans=$5, updates=$6, updated_at=now()
       WHERE guild_id=$1 AND user_id=$2 AND month_key=$3`,
      [guildId, userId, monthKey, newBase, delta, updates]
    );

    fansMonthBaseCache.set(keyGUM(guildId, userId, monthKey), Number(newBase));

    return { monthKey, base: newBase, last, delta, updates };
  }
}

/* ==============================
   匿名投票：UI/ロジック
============================== */
function buildPollEmbed(question, options, isClosed = false, multi = false) {
  const desc = options.map((opt, i) => `**${i + 1}.** ${opt}`).join('\n');
  return new EmbedBuilder()
    .setTitle(isClosed ? '📊 匿名投票（結果）' : '🗳️ 匿名投票')
    .setDescription(`**Q:** ${question}\n\n${desc}`)
    .setFooter({ text: isClosed ? 'この投票は締め切られました' : (multi ? '複数選択が可能です' : '1つだけ選べます') });
}
function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}
function buildPollButtons(options, disabled = false) {
  const rows = [];
  const chunks = chunk(options, 5);
  for (let ci = 0; ci < chunks.length; ci++) {
    const row = new ActionRowBuilder();
    chunks[ci].forEach((_, i) => {
      const index = ci * 5 + i;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`anonpoll:vote:${index}`)
          .setLabel(String(index + 1))
          .setStyle(ButtonStyle.Primary)
          .setDisabled(disabled)
      );
    });
    rows.push(row);
  }
  return rows;
}
async function countPoll(pollId) {
  const { rows } = await pool.query(
    `SELECT choice, COUNT(*)::int AS c FROM anon_votes WHERE poll_id=$1 GROUP BY choice ORDER BY choice`,
    [pollId]
  );
  const map = new Map();
  rows.forEach(r => map.set(Number(r.choice), Number(r.c)));
  return map;
}

/* ==============================
   スラッシュコマンド登録
============================== */
async function registerCommands(applicationId, guilds) {
  const fans = new SlashCommandBuilder()
    .setName('fans')
    .setDescription('ウマ娘ファン数トラッキング')
    .addSubcommand(sc => sc.setName('ui').setDescription('専用パネルをチャンネルに設置'))
    .addSubcommand(sc => sc.setName('set').setDescription('現在の累計ファン数を登録')
      .addIntegerOption(opt => opt.setName('value').setDescription('累計ファン数').setRequired(true)))
    .addSubcommand(sc => sc.setName('ocr').setDescription('スクショから「総獲得数」を読み取り登録（ephemeral）')
      .addAttachmentOption(opt => opt.setName('image').setDescription('進行状況 → ファン → 総獲得数 が写っているスクショ').setRequired(true)))
    .addSubcommand(sc => sc.setName('my').setDescription('自分の月次記録を表示')
      .addStringOption(opt => opt.setName('month').setDescription('YYYY-MM（省略時は今月）')))
    .addSubcommand(sc => sc.setName('edit').setDescription('前回入力の訂正（最新値 / 小さい値も許容）')
      .addIntegerOption(opt => opt.setName('value').setDescription('訂正後の累計ファン数').setRequired(true)))
    .addSubcommand(sc => sc.setName('base').setDescription('今月のベース値（base_fans）を訂正')
      .addIntegerOption(opt => opt.setName('value').setDescription('ベース値（整数）').setRequired(true)));

  const anonpoll = new SlashCommandBuilder()
    .setName('anonpoll')
    .setDescription('匿名投票を作成/管理')
    .addSubcommand(sc => sc.setName('create').setDescription('匿名投票を作成')
      .addStringOption(o => o.setName('question').setDescription('質問文').setRequired(true))
      .addStringOption(o => o.setName('options').setDescription('選択肢（改行・読点・コンマ区切り、最大10）').setRequired(true))
      .addBooleanOption(o => o.setName('multi').setDescription('複数投票を許可する（既定: OFF）')))
    .addSubcommand(sc => sc.setName('close').setDescription('匿名投票を締め切る')
      .addStringOption(o => o.setName('message_id').setDescription('投票メッセージID').setRequired(true)));

  const body = [fans, anonpoll].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  for (const g of guilds) {
    await rest.put(Routes.applicationGuildCommands(applicationId, g.id), { body });
    console.log(`Slash commands registered for guild: ${g.name}`);
  }
}
// ===== END main.mjs (PART 1/2) =====
// ===== BEGIN main.mjs (PART 2/2) =====

/* ==============================
   Bot 起動
============================== */
client.once('ready', async () => {
  await initDB();

  console.log(`✅ Logged in as ${client.user.tag}`);

  const guilds = client.guilds.cache.map(g => g);
  await registerCommands(client.application.id, guilds);

  // ファン数パネルを1回だけ設置（該当ギルドの FANS_CHANNEL_ID に送る）
  for (const g of guilds) {
    try {
      const ch = await client.channels.fetch(FANS_CHANNEL_ID).catch(() => null);
      if (ch && ch.guildId === g.id) {
        const panel = fansPanel();
        await ch.send(panel).catch(() => {});
        break;
      }
    } catch {}
  }
});

/* ==============================
   自動ロール付与（既存）
============================== */
client.on('guildMemberAdd', async member => {
  if (AUTO_ROLE_ID) {
    const role = member.guild.roles.cache.get(AUTO_ROLE_ID);
    if (role) await member.roles.add(role).catch(console.error);
  }
});

/* ==============================
   メッセージ監視（既存）
============================== */
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (!message.guildId) return;
  const member = message.member;
  if (!member) return;

  // ニックネ変更チャンネル
  if (NICKNAME_CHANNEL_ID && message.channel.id === NICKNAME_CHANNEL_ID) {
    if (message.mentions.has(client.user) && message.content.includes('切れ者')) {
      const counts = await loadCount(member.id);
      counts.nickname_changes += 1;

      const percent = Math.floor(Math.random() * 121);
      const newNick = `切れ者確率${percent}%`;

      // 変更前のサーバーニックをDB退避（すでに切れ者確率なら上書きしない）
      const currentNick = member.nickname; // string|null
      if (!KIREMONO_NICK_RE.test(currentNick ?? '')) {
        try {
          await upsertNicknameBackup(message.guildId, member.id, currentNick);
        } catch (e) {
          console.error('nickname backup upsert error:', e);
        }
      }

      await member.setNickname(newNick).catch(console.error);
      await saveCount(member.id, counts);

      await message.channel.send(
        `**お前は${counts.nickname_changes}回目の入浴だねぇ。\n今からお前の名は切れ者確率${percent}% だ。\n分かったら返事をするんだ、切れ者確率${percent}%！！\n${randomReplies[Math.floor(Math.random()*randomReplies.length)]}**`
      );

      const userCounts = await loadCount(member.id);
      await sendOrUpdateButtons(message.channel, member.id, userCounts);
      return;
    }

    // 画像添付（attachments）で「元に戻す」
    if (message.attachments.size > 0) {
      let restored = false;

      try {
        const backup = await fetchNicknameBackup(message.guildId, member.id);

        if (backup.exists) {
          // DBに保存してある「変更前サーバーニック」に復元（NULLならサーバーニック解除）
          await member.setNickname(backup.oldNick).catch(console.error);
          await deleteNicknameBackup(message.guildId, member.id).catch(e => console.error('nickname backup delete error:', e));
          restored = true;
        } else if (KIREMONO_NICK_RE.test(member.nickname ?? '')) {
          // バックアップ無しの安全策：サーバーニック解除
          await member.setNickname(null).catch(console.error);
          restored = true;
        }
      } catch (e) {
        console.error('nickname restore error:', e);
      }

      if (restored) {
        await message.channel.send('**それがお前の答えかい？\nお前の勝ちだ！**');

        if (userButtonMessages.has(member.id)) {
          await userButtonMessages.get(member.id).delete().catch(console.error);
          userButtonMessages.delete(member.id);
        }
      }
    }
  }

  // 集計リセット（COUNT_CHANNEL_ID）
  if (COUNT_CHANNEL_ID && message.channel.id === COUNT_CHANNEL_ID) {
    if (message.mentions.has(client.user) && message.content.includes('バルス')) {
      await resetAllCounts();
      for (const [userId, _] of userButtonMessages.entries()) {
        await sendOrUpdateButtons(message.channel, userId, { kiremono: 0, ritaiya: 0, kirenashi: 0, nickname_changes: 0 });
      }
      await message.channel.send('**全員の集計をリセットしました！**');
      return;
    }
  }

  // ※オートデリート機能は削除済み（ここにも処理なし）
});

/* ==============================
   Interaction（ボタン／モーダル／スラコマ）
============================== */
client.on('interactionCreate', async interaction => {
  try {
    /* ---------- スラッシュコマンド ---------- */
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      /* /fans ... */
      if (commandName === 'fans') {
        const sub = interaction.options.getSubcommand();

        if (interaction.channelId !== FANS_CHANNEL_ID) {
          return interaction.reply({ content: `このコマンドは <#${FANS_CHANNEL_ID}> で使用してください。`, ephemeral: true });
        }

        if (sub === 'ui') {
          const panel = fansPanel();
          await interaction.channel.send(panel);
          return interaction.reply({ content: 'パネルを設置しました。', ephemeral: true });
        }

        if (sub === 'ocr') {
          if (!FANS_OCR_ENABLED) {
            return interaction.reply({ content: '現在、OCR機能は無効化されています（FANS_OCR_ENABLED=false）。', ephemeral: true });
          }

          const now = Date.now();
          const lastRun = fansOcrLastRunAt.get(interaction.user.id) || 0;
          if (now - lastRun < FANS_OCR_MIN_INTERVAL_SEC * 1000) {
            const remain = Math.ceil((FANS_OCR_MIN_INTERVAL_SEC * 1000 - (now - lastRun)) / 1000);
            return interaction.reply({ content: `OCRは連続実行できません。あと${remain}秒お待ちください。`, ephemeral: true });
          }

          await safeDeferReply(interaction, true);

          const attachment = interaction.options.getAttachment('image', true);

          let out;
          try {
            out = await ocrFansTotalFromAttachment(attachment);
          } catch (e) {
            const msg = String(e?.message || e);
            return safeReplyOrEdit(interaction, {
              content:
                `OCR処理に失敗しました：${msg}\n` +
                `（依存が未導入の場合：\`npm i tesseract.js sharp\`）`
            });
          }

          if (out?.tooLarge) {
            return safeReplyOrEdit(interaction, {
              content:
                `OCRは数値を検出しましたが、値が大きすぎて安全に扱えません（Number上限超過）。\n` +
                `この場合は手入力（/fans set かパネルの入力）でお願いします。`
            });
          }

          const value = out?.value;
          if (!Number.isInteger(value) || value < 0) {
            const raw = String(out?.rawText || '').trim();
            return safeReplyOrEdit(interaction, {
              content:
                `OCRで数値が確定できませんでした。\n` +
                `スクショは「進行状況 → ファン → 総獲得数」が**右下に大きく**写っているものをお願いします。\n` +
                (raw ? `\n--- OCR生出力（参考） ---\n${raw.slice(0, 800)}` : '')
            });
          }

          const prev = await fetchLastSnapshotValue(interaction.guildId, interaction.user.id);

          const embed = new EmbedBuilder()
            .setTitle('🧾 OCR結果（総獲得数）')
            .setDescription(
              `読み取り値: **${Number(value).toLocaleString()}**\n` +
              `前回: ${prev === null ? '（未登録）' : prev.toLocaleString()}\n\n` +
              `この値をどう扱いますか？\n` +
              `- **通常登録**: 記録を追加（設定により減少は拒否）\n` +
              `- **訂正**: 最新値として上書き扱い（設定により減少も許可）`
            )
            .setFooter({ text: `目安TTL: ${FANS_OCR_PENDING_TTL_SEC}秒（ボタンが無効になったら再実行してください）` });

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`fans:ocr:use:set:${value}`).setLabel('この値で通常登録').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`fans:ocr:use:edit:${value}`).setLabel('この値で訂正（最新値）').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`fans:ocr:fix:set:${value}`).setLabel('数値を修正して通常登録').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`fans:ocr:fix:edit:${value}`).setLabel('数値を修正して訂正').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`fans:ocr:cancel`).setLabel('キャンセル').setStyle(ButtonStyle.Danger)
          );

          fansOcrLastRunAt.set(interaction.user.id, now);
          return safeReplyOrEdit(interaction, { embeds: [embed], components: [row] });
        }

        if (sub === 'set' || sub === 'edit') {
          const value = interaction.options.getInteger('value', true);
          const now = Date.now();

          if (!(sub === 'edit' && FANS_EDIT_BYPASS_RATE)) {
            const last = fansLastInputAt.get(interaction.user.id) || 0;
            if (now - last < FANS_MIN_INTERVAL_SEC * 1000) {
              const remain = Math.ceil((FANS_MIN_INTERVAL_SEC * 1000 - (now - last)) / 1000);
              return interaction.reply({ content: `連続入力は${FANS_MIN_INTERVAL_SEC}秒間隔です。あと${remain}秒お待ちください。`, ephemeral: true });
            }
          }

          await safeDeferReply(interaction, true);

          const prev = await fetchLastSnapshotValue(interaction.guildId, interaction.user.id);
          const allowDecrease = sub === 'edit' ? FANS_EDIT_ALLOW_DECREASE : FANS_ALLOW_DECREASE;
          if (prev !== null && !allowDecrease && value < prev) {
            return safeReplyOrEdit(interaction, { content: `前回(${prev.toLocaleString()})より小さい値は登録できません。` });
          }

          const result = await insertSnapshotAndUpsertMonthly(
            interaction.guildId,
            interaction.user.id,
            value,
            sub === 'edit' ? 'corrected' : 'manual'
          );
          fansLastInputAt.set(interaction.user.id, now);

          const embed = new EmbedBuilder()
            .setTitle(sub === 'edit' ? '✏️ 訂正を反映しました（最新値）' : '📈 登録完了')
            .setDescription(`**${result.monthKey} の記録**\nベース: ${Number(result.base).toLocaleString()}\n最新: ${Number(result.last).toLocaleString()}\n今月: **+${Number(result.delta).toLocaleString()}**\n更新回数: ${result.updates}`);
          return safeReplyOrEdit(interaction, { embeds: [embed] });
        }

        if (sub === 'base') {
          const value = interaction.options.getInteger('value', true);
          const now = Date.now();

          if (!FANS_BASE_EDIT_BYPASS_RATE) {
            const last = fansLastInputAt.get(interaction.user.id) || 0;
            if (now - last < FANS_MIN_INTERVAL_SEC * 1000) {
              const remain = Math.ceil((FANS_MIN_INTERVAL_SEC * 1000 - (now - last)) / 1000);
              return interaction.reply({ content: `連続操作は${FANS_MIN_INTERVAL_SEC}秒間隔です。あと${remain}秒お待ちください。`, ephemeral: true });
            }
          }

          await safeDeferReply(interaction, true);

          const lastSnap = await fetchLastSnapshotValue(interaction.guildId, interaction.user.id);
          if (lastSnap !== null && !FANS_BASE_EDIT_ALLOW_DECREASE && value > lastSnap) {
            return safeReplyOrEdit(interaction, { content: `現在の最新スナップショット（${lastSnap.toLocaleString()}）より大きいベース値は設定できません。` });
          }

          const result = await correctBaseFans(interaction.guildId, interaction.user.id, value);
          fansLastInputAt.set(interaction.user.id, now);

          const embed = new EmbedBuilder()
            .setTitle('🧱 ベース値を訂正しました（今月）')
            .setDescription(`**${result.monthKey} の記録**\nベース(新): ${Number(result.base).toLocaleString()}\n最新: ${Number(result.last).toLocaleString()}\n今月: **+${Number(result.delta).toLocaleString()}**\n更新回数: ${result.updates}`);
          return safeReplyOrEdit(interaction, { embeds: [embed] });
        }

        if (sub === 'my') {
          const month = interaction.options.getString('month') || getJstMonthKey();
          await safeDeferReply(interaction, true);

          const data = await fetchMyMonth(interaction.guildId, interaction.user.id, month);
          if (!data) {
            return safeReplyOrEdit(interaction, { content: `${month} の記録はまだありません。` });
          }
          const embed = new EmbedBuilder()
            .setTitle('📒 自分の月次記録')
            .setDescription(`**${data.monthKey}**\nベース: ${data.base.toLocaleString()}\n最新: ${data.last.toLocaleString()}\n今月: **+${data.delta.toLocaleString()}**\n更新回数: ${data.updates}`)
            .setFooter({ text: `最終更新: ${new Date(data.updatedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}` });
          return safeReplyOrEdit(interaction, { embeds: [embed] });
        }
      }

      /* /anonpoll ... */
      if (commandName === 'anonpoll') {
        const sub = interaction.options.getSubcommand();

        if (ANONPOLL_CHANNEL_IDS.length && !ANONPOLL_CHANNEL_IDS.includes(interaction.channelId)) {
          return interaction.reply({ content: `このコマンドは許可されたチャンネルでのみ使用できます。`, ephemeral: true });
        }

        if (sub === 'create') {
          const q = interaction.options.getString('question', true).trim();
          const raw = interaction.options.getString('options', true);
          const options = raw
            .split(/[\n、，,]+/g)
            .map(s => s.trim())
            .filter(Boolean)
            .slice(0, ANONPOLL_MAX_OPTIONS);

          if (options.length < 2) {
            return interaction.reply({ content: `選択肢は2個以上、最大${ANONPOLL_MAX_OPTIONS}個で指定してください。`, ephemeral: true });
          }

          const multi = interaction.options.getBoolean('multi') || false;

          await safeDeferReply(interaction, true);

          const embed = buildPollEmbed(q, options, false, multi);
          const components = buildPollButtons(options);
          const msg = await interaction.channel.send({ embeds: [embed], components });

          await pool.query(
            `INSERT INTO anon_polls(poll_id,guild_id,channel_id,question,options,created_by,multi_allowed)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [msg.id, interaction.guildId, interaction.channelId, q, options, interaction.user.id, multi]
          );
          return safeReplyOrEdit(interaction, { content: '匿名投票を作成しました。' });
        }

        if (sub === 'close') {
          const mid = interaction.options.getString('message_id', true);

          await safeDeferReply(interaction, true);

          const { rows } = await pool.query(`SELECT created_by, options, is_closed, question, channel_id FROM anon_polls WHERE poll_id=$1`, [mid]);
          if (!rows.length) return safeReplyOrEdit(interaction, { content: '指定の投票が見つかりません。' });

          const poll = rows[0];
          const isManager = interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages);
          if (interaction.user.id !== poll.created_by && !isManager) {
            return safeReplyOrEdit(interaction, { content: 'この投票を締め切る権限がありません。' });
          }
          if (poll.is_closed) {
            return safeReplyOrEdit(interaction, { content: 'すでに締め切られています。' });
          }

          const counts = await countPoll(mid);
          const options = poll.options;
          const lines = options.map((opt, i) => {
            const c = counts.get(i) || 0;
            return `**${i + 1}.** ${opt} — **${c}票**`;
          }).join('\n');

          const channel = await client.channels.fetch(poll.channel_id).catch(() => null);
          let msg = null;
          if (channel) msg = await channel.messages.fetch(mid).catch(() => null);
          if (msg) {
            const resultEmbed = buildPollEmbed(poll.question, options, true, false)
              .setDescription(`**Q:** ${poll.question}\n\n${lines}`);
            await msg.edit({ embeds: [resultEmbed], components: buildPollButtons(options, true) });
          }
          await pool.query(`UPDATE anon_polls SET is_closed=TRUE WHERE poll_id=$1`, [mid]);
          return safeReplyOrEdit(interaction, { content: '投票を締め切りました。' });
        }
      }
    }

    /* ---------- ボタン ---------- */
    if (interaction.isButton()) {
      const id = interaction.customId;

      // 既存：集計ボタン
      if (WORD_BUTTONS.includes(id)) {
        await safeDeferReply(interaction, true);

        const userId = interaction.user.id;
        if (interaction.message.id !== userButtonMessages.get(userId)?.id) {
          return safeReplyOrEdit(interaction, { content: 'これはあなたのボタンではありません。' });
        }
        const userCounts = await loadCount(userId);
        userCounts[id] += 1;
        await saveCount(userId, userCounts);
        await sendOrUpdateButtons(interaction.channel, userId, userCounts);
        const reply = randomReplies[Math.floor(Math.random() * randomReplies.length)];
        return safeReplyOrEdit(interaction, { content: `**${BUTTON_LABELS[id]} ${userCounts[id]}回目！ ${reply}**` });
      }

      // fans UI
      if (id === 'fans:set') {
        if (interaction.channelId !== FANS_CHANNEL_ID) {
          return interaction.reply({ content: `この操作は <#${FANS_CHANNEL_ID}> で行ってください。`, ephemeral: true });
        }
        const modal = fansModal();
        return interaction.showModal(modal);
      }

      if (id === 'fans:ocr') {
        if (interaction.channelId !== FANS_CHANNEL_ID) {
          return interaction.reply({ content: `この操作は <#${FANS_CHANNEL_ID}> で行ってください。`, ephemeral: true });
        }
        if (!FANS_OCR_ENABLED) {
          return interaction.reply({ content: '現在、OCR機能は無効化されています（FANS_OCR_ENABLED=false）。', ephemeral: true });
        }
        return interaction.reply({
          content:
            `スクショ読み取りは **/fans ocr** を使います。\n` +
            `進行状況 → ファン → **総獲得数** が写っているスクショを添付して実行してください。\n` +
            `（例）/fans ocr 画像: <スクショ>`,
          ephemeral: true
        });
      }

      if (id === 'fans:my') {
        if (interaction.channelId !== FANS_CHANNEL_ID) {
          return interaction.reply({ content: `この操作は <#${FANS_CHANNEL_ID}> で行ってください。`, ephemeral: true });
        }
        await safeDeferReply(interaction, true);

        const data = await fetchMyMonth(interaction.guildId, interaction.user.id, getJstMonthKey());
        if (!data) {
          return safeReplyOrEdit(interaction, { content: `今月の記録はまだありません。` });
        }
        const embed = new EmbedBuilder()
          .setTitle('📒 自分の月次記録')
          .setDescription(`**${data.monthKey}**\nベース: ${data.base.toLocaleString()}\n最新: ${data.last.toLocaleString()}\n今月: **+${data.delta.toLocaleString()}**\n更新回数: ${data.updates}`)
          .setFooter({ text: `最終更新: ${new Date(data.updatedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}` });
        return safeReplyOrEdit(interaction, { embeds: [embed] });
      }

      if (id === 'fans:edit') {
        if (interaction.channelId !== FANS_CHANNEL_ID) {
          return interaction.reply({ content: `この操作は <#${FANS_CHANNEL_ID}> で行ってください。`, ephemeral: true });
        }
        const cachedPrev = fansLastSnapshotCache.get(keyGU(interaction.guildId, interaction.user.id));
        const modal = fansEditModal(typeof cachedPrev === 'number' ? String(cachedPrev) : '');
        return interaction.showModal(modal);
      }

      if (id === 'fans:base') {
        if (interaction.channelId !== FANS_CHANNEL_ID) {
          return interaction.reply({ content: `この操作は <#${FANS_CHANNEL_ID}> で行ってください。`, ephemeral: true });
        }
        const monthKey = getJstMonthKey();
        const cachedBase = fansMonthBaseCache.get(keyGUM(interaction.guildId, interaction.user.id, monthKey));
        const modal = fansBaseModal(typeof cachedBase === 'number' ? String(cachedBase) : '');
        return interaction.showModal(modal);
      }

      // OCRフロー：キャンセル
      if (id === 'fans:ocr:cancel') {
        return interaction.reply({ content: 'キャンセルしました。', ephemeral: true });
      }

      // OCRフロー：修正モーダルを開く
      if (id.startsWith('fans:ocr:fix:')) {
        if (interaction.channelId !== FANS_CHANNEL_ID) {
          return interaction.reply({ content: `この操作は <#${FANS_CHANNEL_ID}> で行ってください。`, ephemeral: true });
        }
        const parts = id.split(':'); // fans ocr fix <mode> <value>
        const mode = parts[3] || 'set';
        const value = parts[4] || '';
        const modal = fansOcrFixModal(String(value), mode === 'edit' ? 'edit' : 'set');
        return interaction.showModal(modal);
      }

      // OCRフロー：この値で登録/訂正
      if (id.startsWith('fans:ocr:use:')) {
        if (interaction.channelId !== FANS_CHANNEL_ID) {
          return interaction.reply({ content: `この操作は <#${FANS_CHANNEL_ID}> で行ってください。`, ephemeral: true });
        }

        const parts = id.split(':'); // fans ocr use <mode> <value>
        const mode = parts[3] || 'set';
        const rawVal = parts[4] || '';
        const value = Number(String(rawVal).replace(/[,，\s]/g, ''));

        if (!Number.isInteger(value) || value < 0) {
          return interaction.reply({ content: '値の解釈に失敗しました。/fans ocr をやり直してください。', ephemeral: true });
        }

        const now = Date.now();

        if (!(mode === 'edit' && FANS_EDIT_BYPASS_RATE)) {
          const last = fansLastInputAt.get(interaction.user.id) || 0;
          if (now - last < FANS_MIN_INTERVAL_SEC * 1000) {
            const remain = Math.ceil((FANS_MIN_INTERVAL_SEC * 1000 - (now - last)) / 1000);
            return interaction.reply({ content: `連続入力は${FANS_MIN_INTERVAL_SEC}秒間隔です。あと${remain}秒お待ちください。`, ephemeral: true });
          }
        }

        await safeDeferReply(interaction, true);

        const prev = await fetchLastSnapshotValue(interaction.guildId, interaction.user.id);
        const allowDecrease = mode === 'edit' ? FANS_EDIT_ALLOW_DECREASE : FANS_ALLOW_DECREASE;

        if (prev !== null && !allowDecrease && value < prev) {
          return safeReplyOrEdit(interaction, { content: `前回(${prev.toLocaleString()})より小さい値は登録できません。訂正として登録するか、手入力で見直してください。` });
        }

        const result = await insertSnapshotAndUpsertMonthly(
          interaction.guildId,
          interaction.user.id,
          value,
          mode === 'edit' ? 'ocr_corrected' : 'ocr'
        );
        fansLastInputAt.set(interaction.user.id, now);

        const embed = new EmbedBuilder()
          .setTitle(mode === 'edit' ? '🧾 OCR訂正を反映しました（最新値）' : '🧾 OCRで登録しました')
          .setDescription(`**${result.monthKey} の記録**\nベース: ${Number(result.base).toLocaleString()}\n最新: ${Number(result.last).toLocaleString()}\n今月: **+${Number(result.delta).toLocaleString()}**\n更新回数: ${result.updates}`);
        return safeReplyOrEdit(interaction, { embeds: [embed], components: [] });
      }

      // 匿名投票：投票
      if (id.startsWith('anonpoll:vote:')) {
        await safeDeferReply(interaction, true);

        const idx = Number(id.split(':')[2] || '0');
        const pollId = interaction.message.id;

        const { rows } = await pool.query(`SELECT is_closed, multi_allowed FROM anon_polls WHERE poll_id=$1`, [pollId]);
        if (!rows.length) return safeReplyOrEdit(interaction, { content: '投票データが見つかりません。' });
        if (rows[0].is_closed) return safeReplyOrEdit(interaction, { content: 'この投票は締め切られています。' });

        const multi = rows[0].multi_allowed;

        if (multi) {
          const exists = await pool.query(
            `SELECT 1 FROM anon_votes WHERE poll_id=$1 AND user_id=$2 AND choice=$3`,
            [pollId, interaction.user.id, idx]
          );
          if (exists.rowCount) {
            await pool.query(
              `DELETE FROM anon_votes WHERE poll_id=$1 AND user_id=$2 AND choice=$3`,
              [pollId, interaction.user.id, idx]
            );
          } else {
            await pool.query(
              `INSERT INTO anon_votes(poll_id,user_id,choice) VALUES ($1,$2,$3)
               ON CONFLICT (poll_id,user_id,choice) DO UPDATE SET voted_at=now()`,
              [pollId, interaction.user.id, idx]
            );
          }
        } else {
          await pool.query(`DELETE FROM anon_votes WHERE poll_id=$1 AND user_id=$2`, [pollId, interaction.user.id]);
          await pool.query(
            `INSERT INTO anon_votes(poll_id,user_id,choice) VALUES ($1,$2,$3)`,
            [pollId, interaction.user.id, idx]
          );
        }

        const counts = await countPoll(pollId);
        const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);
        return safeReplyOrEdit(interaction, { content: `投票を受け付けました（現在の総投票数：${total}）。` });
      }
    }

    /* ---------- モーダル ---------- */
    if (interaction.type === InteractionType.ModalSubmit) {
      if (interaction.customId === 'fans:modal') {
        if (interaction.channelId !== FANS_CHANNEL_ID) {
          return interaction.reply({ content: `この操作は <#${FANS_CHANNEL_ID}> で行ってください。`, ephemeral: true });
        }
        await safeDeferReply(interaction, true);

        const raw = interaction.fields.getTextInputValue('fans:value').replace(/[,，\s]/g, '');
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 0) {
          return safeReplyOrEdit(interaction, { content: '整数の累計ファン数を入力してください。' });
        }

        const now = Date.now();
        const last = fansLastInputAt.get(interaction.user.id) || 0;
        if (now - last < FANS_MIN_INTERVAL_SEC * 1000) {
          const remain = Math.ceil((FANS_MIN_INTERVAL_SEC * 1000 - (now - last)) / 1000);
          return safeReplyOrEdit(interaction, { content: `連続入力は${FANS_MIN_INTERVAL_SEC}秒間隔です。あと${remain}秒お待ちください。` });
        }

        const prev = await fetchLastSnapshotValue(interaction.guildId, interaction.user.id);
        if (prev !== null && !FANS_ALLOW_DECREASE && value < prev) {
          return safeReplyOrEdit(interaction, { content: `前回(${prev.toLocaleString()})より小さい値は登録できません。` });
        }

        const result = await insertSnapshotAndUpsertMonthly(interaction.guildId, interaction.user.id, value, 'manual');
        fansLastInputAt.set(interaction.user.id, now);

        const embed = new EmbedBuilder()
          .setTitle('📈 登録完了')
          .setDescription(`**${result.monthKey} の記録**\nベース: ${Number(result.base).toLocaleString()}\n最新: ${Number(result.last).toLocaleString()}\n今月: **+${Number(result.delta).toLocaleString()}**\n更新回数: ${result.updates}`);
        return safeReplyOrEdit(interaction, { embeds: [embed] });
      }

      if (interaction.customId === 'fans:modal_edit') {
        if (interaction.channelId !== FANS_CHANNEL_ID) {
          return interaction.reply({ content: `この操作は <#${FANS_CHANNEL_ID}> で行ってください。`, ephemeral: true });
        }
        await safeDeferReply(interaction, true);

        const raw = interaction.fields.getTextInputValue('fans:value_edit').replace(/[,，\s]/g, '');
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 0) {
          return safeReplyOrEdit(interaction, { content: '整数の累計ファン数を入力してください。' });
        }

        const now = Date.now();
        if (!FANS_EDIT_BYPASS_RATE) {
          const last = fansLastInputAt.get(interaction.user.id) || 0;
          if (now - last < FANS_MIN_INTERVAL_SEC * 1000) {
            const remain = Math.ceil((FANS_MIN_INTERVAL_SEC * 1000 - (now - last)) / 1000);
            return safeReplyOrEdit(interaction, { content: `連続入力は${FANS_MIN_INTERVAL_SEC}秒間隔です。あと${remain}秒お待ちください。` });
          }
        }

        const prev = await fetchLastSnapshotValue(interaction.guildId, interaction.user.id);
        if (prev !== null && !FANS_EDIT_ALLOW_DECREASE && value < prev) {
          return safeReplyOrEdit(interaction, { content: `設定により小さい値での訂正は許可されていません。` });
        }

        const result = await insertSnapshotAndUpsertMonthly(interaction.guildId, interaction.user.id, value, 'corrected');
        fansLastInputAt.set(interaction.user.id, now);

        const embed = new EmbedBuilder()
          .setTitle('✏️ 訂正を反映しました（最新値）')
          .setDescription(`**${result.monthKey} の記録**\nベース: ${Number(result.base).toLocaleString()}\n最新: ${Number(result.last).toLocaleString()}\n今月: **+${Number(result.delta).toLocaleString()}**\n更新回数: ${result.updates}`);
        return safeReplyOrEdit(interaction, { embeds: [embed] });
      }

      if (interaction.customId === 'fans:modal_base') {
        if (interaction.channelId !== FANS_CHANNEL_ID) {
          return interaction.reply({ content: `この操作は <#${FANS_CHANNEL_ID}> で行ってください。`, ephemeral: true });
        }
        await safeDeferReply(interaction, true);

        const raw = interaction.fields.getTextInputValue('fans:value_base').replace(/[,，\s]/g, '');
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 0) {
          return safeReplyOrEdit(interaction, { content: '整数のベース値を入力してください。' });
        }

        const now = Date.now();
        if (!FANS_BASE_EDIT_BYPASS_RATE) {
          const last = fansLastInputAt.get(interaction.user.id) || 0;
          if (now - last < FANS_MIN_INTERVAL_SEC * 1000) {
            const remain = Math.ceil((FANS_MIN_INTERVAL_SEC * 1000 - (now - last)) / 1000);
            return safeReplyOrEdit(interaction, { content: `連続操作は${FANS_MIN_INTERVAL_SEC}秒間隔です。あと${remain}秒お待ちください。` });
          }
        }

        const lastSnap = await fetchLastSnapshotValue(interaction.guildId, interaction.user.id);
        if (lastSnap !== null && !FANS_BASE_EDIT_ALLOW_DECREASE && value > lastSnap) {
          return safeReplyOrEdit(interaction, { content: `現在の最新スナップショット（${lastSnap.toLocaleString()}）より大きいベース値は設定できません。` });
        }

        const result = await correctBaseFans(interaction.guildId, interaction.user.id, value);
        fansLastInputAt.set(interaction.user.id, now);

        const embed = new EmbedBuilder()
          .setTitle('🧱 ベース値を訂正しました（今月）')
          .setDescription(`**${result.monthKey} の記録**\nベース(新): ${Number(result.base).toLocaleString()}\n最新: ${Number(result.last).toLocaleString()}\n今月: **+${Number(result.delta).toLocaleString()}**\n更新回数: ${result.updates}`);
        return safeReplyOrEdit(interaction, { embeds: [embed] });
      }

      // OCR修正モーダル
      if (interaction.customId.startsWith('fans:ocr:modal_fix:')) {
        if (interaction.channelId !== FANS_CHANNEL_ID) {
          return interaction.reply({ content: `この操作は <#${FANS_CHANNEL_ID}> で行ってください。`, ephemeral: true });
        }
        await safeDeferReply(interaction, true);

        const parts = interaction.customId.split(':'); // fans ocr modal_fix <mode> <defaultValue?>
        const mode = parts[3] || 'set';

        const raw = interaction.fields.getTextInputValue('fans:ocr_value_fix').replace(/[,，\s]/g, '');
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 0) {
          return safeReplyOrEdit(interaction, { content: '整数の累計ファン数を入力してください。' });
        }

        const now = Date.now();

        if (!(mode === 'edit' && FANS_EDIT_BYPASS_RATE)) {
          const last = fansLastInputAt.get(interaction.user.id) || 0;
          if (now - last < FANS_MIN_INTERVAL_SEC * 1000) {
            const remain = Math.ceil((FANS_MIN_INTERVAL_SEC * 1000 - (now - last)) / 1000);
            return safeReplyOrEdit(interaction, { content: `連続入力は${FANS_MIN_INTERVAL_SEC}秒間隔です。あと${remain}秒お待ちください。` });
          }
        }

        const prev = await fetchLastSnapshotValue(interaction.guildId, interaction.user.id);
        const allowDecrease = mode === 'edit' ? FANS_EDIT_ALLOW_DECREASE : FANS_ALLOW_DECREASE;

        if (prev !== null && !allowDecrease && value < prev) {
          return safeReplyOrEdit(interaction, { content: `前回(${prev.toLocaleString()})より小さい値は登録できません。` });
        }

        const result = await insertSnapshotAndUpsertMonthly(
          interaction.guildId,
          interaction.user.id,
          value,
          mode === 'edit' ? 'ocr_corrected' : 'ocr'
        );
        fansLastInputAt.set(interaction.user.id, now);

        const embed = new EmbedBuilder()
          .setTitle(mode === 'edit' ? '🧾 OCR修正で訂正を反映しました' : '🧾 OCR修正で登録しました')
          .setDescription(`**${result.monthKey} の記録**\nベース: ${Number(result.base).toLocaleString()}\n最新: ${Number(result.last).toLocaleString()}\n今月: **+${Number(result.delta).toLocaleString()}**\n更新回数: ${result.updates}`);
        return safeReplyOrEdit(interaction, { embeds: [embed] });
      }
    }
  } catch (err) {
    console.error('interaction error:', err);

    const msg = isLikelyDbPausedError(err) ? dbPausedUserMessage() : 'エラーが発生しました。';

    try {
      if (typeof interaction?.reply === 'function') {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: msg }).catch(() => {});
        } else {
          await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
        }
      }
    } catch {}
  }
});

/* ==============================
   Bot ログイン
============================== */
client.login(process.env.DISCORD_TOKEN);

// ===== END main.mjs (PART 2/2) =====
