// ==============================
// main.mjs  — 完全版（Node 22 / discord.js v14 / Neon / Render / JST）
// 互換維持：counts / auto_delete / fan_snapshots + fan_monthly / anon_polls(multi) / anon_votes(PK拡張)
//           / スラコマ /fans /anonpoll / Express keep-alive / 定期削除
// 変更点：ファン数トラッキングに「ベース値訂正」ボタン＆/fans edit を追加
// ==============================

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
const AUTO_DELETE_CHANNEL_ID = process.env.AUTO_DELETE_CHANNEL_ID;
const AUTO_ROLE_ID = process.env.AUTO_ROLE_ID;

// ★ ファン数UI用チャンネル（単一）
const FANS_CHANNEL_ID = process.env.FANS_CHANNEL_ID || '1425079163005571132';
// 入力レート制限（秒）
const FANS_MIN_INTERVAL_SEC = parseInt(process.env.FANS_MIN_INTERVAL_SEC || '30', 10);
// 減少値を許可するか（通常入力）
const FANS_ALLOW_DECREASE = (process.env.FANS_ALLOW_DECREASE || 'false').toLowerCase() === 'true';
// ★ 訂正時は減少も許可するか（既定 true）
const FANS_EDIT_ALLOW_DECREASE = (process.env.FANS_EDIT_ALLOW_DECREASE || 'true').toLowerCase() === 'true';
// ★ 訂正はレート制限をバイパスするか（既定 true）
const FANS_EDIT_BYPASS_RATE = (process.env.FANS_EDIT_BYPASS_RATE || 'true').toLowerCase() === 'true';

// 匿名投票の許可チャンネル（未指定ならどこでもOK、カンマ区切り）
const ANONPOLL_CHANNEL_IDS = (process.env.ANONPOLL_CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
// ★ 匿名投票：最大選択肢数（既定 10、Discord 25ボタン制約に配慮）
const ANONPOLL_MAX_OPTIONS = Math.min(parseInt(process.env.ANONPOLL_MAX_OPTIONS || '10', 10) || 10, 25);

/* ==============================
   DB 接続
============================== */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
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

  // 既存：自動削除メッセージ
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auto_delete_messages (
      message_id BIGINT PRIMARY KEY,
      channel_id BIGINT NOT NULL,
      delete_at BIGINT NOT NULL
    )
  `);

  // 既存：ファン数スナップショット
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

  // 既存：月次集計（JST 月キー）
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

  // 既存：匿名投票（multi_allowed あり）
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
  await pool.query(`ALTER TABLE anon_polls ADD COLUMN IF NOT EXISTS multi_allowed BOOLEAN NOT NULL DEFAULT FALSE`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS anon_votes (
      poll_id   TEXT NOT NULL,
      user_id   TEXT NOT NULL,
      choice    INT  NOT NULL,
      voted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // 既存 PK を (poll_id,user_id,choice) へ拡張（冪等）
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

  // FK（冪等）
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
}

/* ==============================
   ユーティリティ
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

// JST の YYYY-MM
function getJstMonthKey(date = new Date()) {
  const d = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// 入力のレート制限（ユーザー単位）
const fansLastInputAt = new Map();

/* ==============================
   DB ヘルパー（counts）
============================== */
async function loadCount(userId) {
  const { rows } = await pool.query('SELECT * FROM counts WHERE user_id=$1', [userId]);
  if (!rows.length) return { kiremono:0, ritaiya:0, kirenashi:0, nickname_changes:0 };
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
   counts ボタン UI
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
   ファン数：UI（ベース値訂正ボタン付き）
============================== */
function fansPanel() {
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle('📈 ウマ娘 ファン数トラッキング（JST）')
        .setDescription('月初にベース値を登録し、月途中で最新の**累計ファン数**を入れると今月の増分が分かります。')
        .setFooter({ text: '入力は本人にのみ見える形で返信します（ephemeral）' })
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('fans:set').setLabel('現在の累計ファン数を入力').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('fans:my').setLabel('自分の記録を見る').setStyle(ButtonStyle.Primary),
        // ★ 変更点：訂正ボタンを追加
        new ButtonBuilder().setCustomId('fans:edit').setLabel('前回入力を訂正').setStyle(ButtonStyle.Secondary)
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
    .setTitle('訂正：累計ファン数を入力（上書き）')
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

/* ==============================
   ファン数：ロジック
============================== */
async function insertSnapshotAndUpsertMonthly(guildId, userId, value, source = 'manual') {
  // スナップショット保存
  await pool.query(
    `INSERT INTO fan_snapshots (guild_id, user_id, fans_total, source) VALUES ($1,$2,$3,$4)`,
    [guildId, userId, value, source]
  );

  // 月次アップサート（JST基準）
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
    return { monthKey, base: value, last: value, delta: 0, updates: 1 };
  } else {
    const base = Number(rows[0].base_fans);
    const updates = Number(rows[0].updates) + 1;
    const last = value;
    const delta = Math.max(0, last - base);
    await pool.query(
      `UPDATE fan_monthly
       SET last_fans=$4, delta_fans=$5, updates=$6, updated_at=now()
       WHERE guild_id=$1 AND user_id=$2 AND month_key=$3`,
      [guildId, userId, monthKey, last, delta, updates]
    );
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
  const { rows } = await pool.query(
    `SELECT fans_total FROM fan_snapshots WHERE guild_id=$1 AND user_id=$2 ORDER BY snapshot_ts DESC LIMIT 1`,
    [guildId, userId]
  );
  return rows.length ? Number(rows[0].fans_total) : null;
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
  // /fans ui, /fans set, /fans my, /fans edit
  const fans = new SlashCommandBuilder()
    .setName('fans')
    .setDescription('ウマ娘ファン数トラッキング')
    .addSubcommand(sc => sc.setName('ui').setDescription('専用パネルをチャンネルに設置'))
    .addSubcommand(sc => sc.setName('set').setDescription('現在の累計ファン数を登録')
      .addIntegerOption(opt => opt.setName('value').setDescription('累計ファン数').setRequired(true)))
    .addSubcommand(sc => sc.setName('my').setDescription('自分の月次記録を表示')
      .addStringOption(opt => opt.setName('month').setDescription('YYYY-MM（省略時は今月）')))
    // ★ 訂正（小さい値も許容、設定で可変）
    .addSubcommand(sc => sc.setName('edit').setDescription('前回入力の訂正（小さい値も許容）')
      .addIntegerOption(opt => opt.setName('value').setDescription('訂正後の累計ファン数').setRequired(true)));

  // /anonpoll create, /anonpoll close
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

/* ==============================
   Bot 起動
============================== */
client.once('ready', async () => {
  await initDB();
  console.log(`✅ Logged in as ${client.user.tag}`);

  // スラッシュコマンド登録（参加している全ギルド）
  const guilds = client.guilds.cache.map(g => g);
  await registerCommands(client.application.id, guilds);

  // ファン数パネルを専用chに（存在すれば）設置
  for (const g of guilds) {
    try {
      const ch = await client.channels.fetch(FANS_CHANNEL_ID).catch(() => null);
      if (ch && ch.guildId === g.id) {
        const panel = fansPanel();
        await ch.send(panel).catch(() => {});
        break; // 単一チャンネル想定
      }
    } catch {}
  }
});

/* ==============================
   自動ロール付与
============================== */
client.on('guildMemberAdd', async member => {
  if (AUTO_ROLE_ID) {
    const role = member.guild.roles.cache.get(AUTO_ROLE_ID);
    if (role) await member.roles.add(role).catch(console.error);
  }
});

/* ==============================
   メッセージ監視（counts / auto_delete）
============================== */
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  const member = message.member;

  // ニックネ変更チャンネル：切れ者ネタ
  if (message.channel.id === NICKNAME_CHANNEL_ID) {
    if (message.mentions.has(client.user) && message.content.includes('切れ者')) {
      const counts = await loadCount(member.id);
      counts.nickname_changes += 1;
      const percent = Math.floor(Math.random() * 121);
      const newNick = `切れ者確率${percent}%`;
      await member.setNickname(newNick).catch(console.error);
      await saveCount(member.id, counts);

      await message.channel.send(
        `**お前は${counts.nickname_changes}回目の入浴だねぇ。\n今からお前の名は切れ者確率${percent}% だ。\n分かったら返事をするんだ、切れ者確率${percent}%！！\n${randomReplies[Math.floor(Math.random()*randomReplies.length)]}**`
      );

      const userCounts = await loadCount(member.id);
      await sendOrUpdateButtons(message.channel, member.id, userCounts);
      return;
    }

    if (message.attachments.size > 0) {
      const oldNick = member.nickname?.match(/切れ者確率\d+%/) ? member.user.username : member.nickname;
      if (oldNick) {
        await member.setNickname(oldNick).catch(console.error);
        await message.channel.send('**それがお前の答えかい？\nお前の勝ちだ！**');

        if (userButtonMessages.has(member.id)) {
          await userButtonMessages.get(member.id).delete().catch(console.error);
          userButtonMessages.delete(member.id);
        }
      }
    }
  }

  // 集計リセット（COUNT_CHANNEL_ID）
  if (message.channel.id === COUNT_CHANNEL_ID) {
    if (message.mentions.has(client.user) && message.content.includes('バルス')) {
      await resetAllCounts();
      for (const [userId] of userButtonMessages.entries()) {
        await sendOrUpdateButtons(message.channel, userId, { kiremono:0, ritaiya:0, kirenashi:0, nickname_changes:0 });
      }
      await message.channel.send('**全員の集計をリセットしました！**');
      return;
    }
  }

  // 自動削除メッセージ登録（AUTO_DELETE_CHANNEL_ID）
  if (message.channel.id === AUTO_DELETE_CHANNEL_ID) {
    try {
      const deleteAt = Date.now() + 24 * 60 * 60 * 1000; // 24時間後
      await pool.query(
        'INSERT INTO auto_delete_messages(message_id, channel_id, delete_at) VALUES($1, $2, $3)',
        [message.id, message.channel.id, deleteAt]
      );
    } catch (err) {
      console.error('自動削除メッセージ登録エラー:', err);
    }
  }
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

        // チャンネル制約
        if (interaction.channelId !== FANS_CHANNEL_ID) {
          return interaction.reply({ content: `このコマンドは <#${FANS_CHANNEL_ID}> で使用してください。`, ephemeral: true });
        }

        if (sub === 'ui') {
          const panel = fansPanel();
          await interaction.channel.send(panel);
          return interaction.reply({ content: 'パネルを設置しました。', ephemeral: true });
        }

        if (sub === 'set' || sub === 'edit') {
          const value = interaction.options.getInteger('value', true);
          const now = Date.now();

          // レート制限（edit は設定に応じてバイパス）
          if (!(sub === 'edit' && FANS_EDIT_BYPASS_RATE)) {
            const last = fansLastInputAt.get(interaction.user.id) || 0;
            if (now - last < FANS_MIN_INTERVAL_SEC * 1000) {
              const remain = Math.ceil((FANS_MIN_INTERVAL_SEC * 1000 - (now - last)) / 1000);
              return interaction.reply({ content: `連続入力は${FANS_MIN_INTERVAL_SEC}秒間隔です。あと${remain}秒お待ちください。`, ephemeral: true });
            }
          }

          // 直近値と減少許可
          const prev = await fetchLastSnapshotValue(interaction.guildId, interaction.user.id);
          const allowDecrease = sub === 'edit' ? FANS_EDIT_ALLOW_DECREASE : FANS_ALLOW_DECREASE;
          if (prev !== null && !allowDecrease && value < prev) {
            return interaction.reply({ content: `前回(${prev.toLocaleString()})より小さい値は登録できません。`, ephemeral: true });
          }

          const result = await insertSnapshotAndUpsertMonthly(
            interaction.guildId,
            interaction.user.id,
            value,
            sub === 'edit' ? 'corrected' : 'manual'
          );
          fansLastInputAt.set(interaction.user.id, now);

          const embed = new EmbedBuilder()
            .setTitle(sub === 'edit' ? '✏️ 訂正を反映しました' : '📈 登録完了')
            .setDescription(`**${result.monthKey} の記録**\nベース: ${result.base.toLocaleString()}\n最新: ${result.last.toLocaleString()}\n今月: **+${result.delta.toLocaleString()}**\n更新回数: ${result.updates}`);
          return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        if (sub === 'my') {
          const month = interaction.options.getString('month') || getJstMonthKey();
          const data = await fetchMyMonth(interaction.guildId, interaction.user.id, month);
          if (!data) {
            return interaction.reply({ content: `${month} の記録はまだありません。`, ephemeral: true });
          }
          const embed = new EmbedBuilder()
            .setTitle('📒 自分の月次記録')
            .setDescription(`**${data.monthKey}**\nベース: ${data.base.toLocaleString()}\n最新: ${data.last.toLocaleString()}\n今月: **+${data.delta.toLocaleString()}**\n更新回数: ${data.updates}`)
            .setFooter({ text: `最終更新: ${new Date(data.updatedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}` });
          return interaction.reply({ embeds: [embed], ephemeral: true });
        }
      }

      /* /anonpoll ... */
      if (commandName === 'anonpoll') {
        const sub = interaction.options.getSubcommand();

        // チャンネル制約（設定されていれば）
        if (ANONPOLL_CHANNEL_IDS.length && !ANONPOLL_CHANNEL_IDS.includes(interaction.channelId)) {
          return interaction.reply({ content: `このコマンドは許可されたチャンネルでのみ使用できます。`, ephemeral: true });
        }

        if (sub === 'create') {
          const q = interaction.options.getString('question', true).trim();
          const raw = interaction.options.getString('options', true);
          // 日本語入力しやすい分割：改行 / 読点 / 全角コンマ / 半角カンマ
          const options = raw
            .split(/[\n、，,]+/g)
            .map(s => s.trim())
            .filter(Boolean)
            .slice(0, ANONPOLL_MAX_OPTIONS);

          if (options.length < 2) {
            return interaction.reply({ content: `選択肢は2個以上、最大${ANONPOLL_MAX_OPTIONS}個で指定してください。`, ephemeral: true });
          }

          const multi = interaction.options.getBoolean('multi') || false;

          const embed = buildPollEmbed(q, options, false, multi);
          const components = buildPollButtons(options);
          const msg = await interaction.channel.send({ embeds: [embed], components });

          // 保存（poll_id=message.id）
          await pool.query(
            `INSERT INTO anon_polls(poll_id,guild_id,channel_id,question,options,created_by,multi_allowed)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [msg.id, interaction.guildId, interaction.channelId, q, options, interaction.user.id, multi]
          );
          return interaction.reply({ content: '匿名投票を作成しました。', ephemeral: true });
        }

        if (sub === 'close') {
          const mid = interaction.options.getString('message_id', true);
          const { rows } = await pool.query(`SELECT created_by, options, is_closed, question, channel_id FROM anon_polls WHERE poll_id=$1`, [mid]);
          if (!rows.length) return interaction.reply({ content: '指定の投票が見つかりません。', ephemeral: true });
          const poll = rows[0];
          const isManager = interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages);
          if (interaction.user.id !== poll.created_by && !isManager) {
            return interaction.reply({ content: 'この投票を締め切る権限がありません。', ephemeral: true });
          }
          if (poll.is_closed) {
            return interaction.reply({ content: 'すでに締め切られています。', ephemeral: true });
          }

          // 集計
          const counts = await countPoll(mid);
          const options = poll.options;
          const lines = options.map((opt, i) => {
            const c = counts.get(i) || 0;
            return `**${i + 1}.** ${opt} — **${c}票**`;
          }).join('\n');

          // メッセージ編集（ボタン無効化 & 結果表示）
          const channel = await client.channels.fetch(poll.channel_id).catch(() => null);
          let msg = null;
          if (channel) msg = await channel.messages.fetch(mid).catch(() => null);
          if (msg) {
            const resultEmbed = buildPollEmbed(poll.question, options, true, false).setDescription(`**Q:** ${poll.question}\n\n${lines}`);
            await msg.edit({ embeds: [resultEmbed], components: buildPollButtons(options, true) });
          }
          await pool.query(`UPDATE anon_polls SET is_closed=TRUE WHERE poll_id=$1`, [mid]);
          return interaction.reply({ content: '投票を締め切りました。', ephemeral: true });
        }
      }
    }

    /* ---------- ボタン ---------- */
    if (interaction.isButton()) {
      const id = interaction.customId;

      // counts 既存
      if (WORD_BUTTONS.includes(id)) {
        const userId = interaction.user.id;
        if (interaction.message.id !== userButtonMessages.get(userId)?.id) {
          return interaction.reply({ content: 'これはあなたのボタンではありません。', ephemeral: true });
        }
        const userCounts = await loadCount(userId);
        userCounts[id] += 1;
        await saveCount(userId, userCounts);
        await sendOrUpdateButtons(interaction.channel, userId, userCounts);
        const reply = randomReplies[Math.floor(Math.random() * randomReplies.length)];
        return interaction.reply({ content: `**${BUTTON_LABELS[id]} ${userCounts[id]}回目！ ${reply}**`, ephemeral: true });
      }

      // ファン数：入力
      if (id === 'fans:set') {
        if (interaction.channelId !== FANS_CHANNEL_ID) {
          return interaction.reply({ content: `この操作は <#${FANS_CHANNEL_ID}> で行ってください。`, ephemeral: true });
        }
        const modal = fansModal();
        return interaction.showModal(modal);
      }

      // ファン数：自分の記録
      if (id === 'fans:my') {
        if (interaction.channelId !== FANS_CHANNEL_ID) {
          return interaction.reply({ content: `この操作は <#${FANS_CHANNEL_ID}> で行ってください。`, ephemeral: true });
        }
        const data = await fetchMyMonth(interaction.guildId, interaction.user.id, getJstMonthKey());
        if (!data) {
          return interaction.reply({ content: `今月の記録はまだありません。`, ephemeral: true });
        }
        const embed = new EmbedBuilder()
          .setTitle('📒 自分の月次記録')
          .setDescription(`**${data.monthKey}**\nベース: ${data.base.toLocaleString()}\n最新: ${data.last.toLocaleString()}\n今月: **+${data.delta.toLocaleString()}**\n更新回数: ${data.updates}`)
          .setFooter({ text: `最終更新: ${new Date(data.updatedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}` });
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      // ★ ファン数：訂正モーダル
      if (id === 'fans:edit') {
        if (interaction.channelId !== FANS_CHANNEL_ID) {
          return interaction.reply({ content: `この操作は <#${FANS_CHANNEL_ID}> で行ってください。`, ephemeral: true });
        }
        const prev = await fetchLastSnapshotValue(interaction.guildId, interaction.user.id);
        const modal = fansEditModal(prev !== null ? String(prev) : '');
        return interaction.showModal(modal);
      }

      // 匿名投票：投票ボタン
      if (id.startsWith('anonpoll:vote:')) {
        const idx = Number(id.split(':')[2] || '0');
        const pollId = interaction.message.id;

        const { rows } = await pool.query(`SELECT is_closed, multi_allowed FROM anon_polls WHERE poll_id=$1`, [pollId]);
        if (!rows.length) return interaction.reply({ content: '投票データが見つかりません。', ephemeral: true });
        if (rows[0].is_closed) return interaction.reply({ content: 'この投票は締め切られています。', ephemeral: true });

        const multi = rows[0].multi_allowed;

        if (multi) {
          // 複数選択：トグル
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
          // 単独選択：以前の票を全削除 → 今回の票をセット
          await pool.query(`DELETE FROM anon_votes WHERE poll_id=$1 AND user_id=$2`, [pollId, interaction.user.id]);
          await pool.query(
            `INSERT INTO anon_votes(poll_id,user_id,choice) VALUES ($1,$2,$3)`,
            [pollId, interaction.user.id, idx]
          );
        }

        // 現在票数（匿名のまま本人に通知）
        const counts = await countPoll(pollId);
        const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);
        return interaction.reply({ content: `投票を受け付けました（現在の総投票数：${total}）。`, ephemeral: true });
      }
    }

    /* ---------- モーダル ---------- */
    if (interaction.type === InteractionType.ModalSubmit) {
      // 通常入力
      if (interaction.customId === 'fans:modal') {
        if (interaction.channelId !== FANS_CHANNEL_ID) {
          return interaction.reply({ content: `この操作は <#${FANS_CHANNEL_ID}> で行ってください。`, ephemeral: true });
        }
        const raw = interaction.fields.getTextInputValue('fans:value').replace(/[,，\s]/g, '');
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 0) {
          return interaction.reply({ content: '整数の累計ファン数を入力してください。', ephemeral: true });
        }

        const now = Date.now();
        const last = fansLastInputAt.get(interaction.user.id) || 0;
        if (now - last < FANS_MIN_INTERVAL_SEC * 1000) {
          const remain = Math.ceil((FANS_MIN_INTERVAL_SEC * 1000 - (now - last)) / 1000);
          return interaction.reply({ content: `連続入力は${FANS_MIN_INTERVAL_SEC}秒間隔です。あと${remain}秒お待ちください。`, ephemeral: true });
        }

        // 減少チェック
        const prev = await fetchLastSnapshotValue(interaction.guildId, interaction.user.id);
        if (prev !== null && !FANS_ALLOW_DECREASE && value < prev) {
          return interaction.reply({ content: `前回(${prev.toLocaleString()})より小さい値は登録できません。`, ephemeral: true });
        }

        const result = await insertSnapshotAndUpsertMonthly(interaction.guildId, interaction.user.id, value, 'manual');
        fansLastInputAt.set(interaction.user.id, now);

        const embed = new EmbedBuilder()
          .setTitle('📈 登録完了')
          .setDescription(`**${result.monthKey} の記録**\nベース: ${result.base.toLocaleString()}\n最新: ${result.last.toLocaleString()}\n今月: **+${result.delta.toLocaleString()}**\n更新回数: ${result.updates}`);
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      // ★ 訂正
      if (interaction.customId === 'fans:modal_edit') {
        if (interaction.channelId !== FANS_CHANNEL_ID) {
          return interaction.reply({ content: `この操作は <#${FANS_CHANNEL_ID}> で行ってください。`, ephemeral: true });
        }
        const raw = interaction.fields.getTextInputValue('fans:value_edit').replace(/[,，\s]/g, '');
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 0) {
          return interaction.reply({ content: '整数の累計ファン数を入力してください。', ephemeral: true });
        }

        const now = Date.now();
        if (!FANS_EDIT_BYPASS_RATE) {
          const last = fansLastInputAt.get(interaction.user.id) || 0;
          if (now - last < FANS_MIN_INTERVAL_SEC * 1000) {
            const remain = Math.ceil((FANS_MIN_INTERVAL_SEC * 1000 - (now - last)) / 1000);
            return interaction.reply({ content: `連続入力は${FANS_MIN_INTERVAL_SEC}秒間隔です。あと${remain}秒お待ちください。`, ephemeral: true });
          }
        }

        // 設定により減少も許可可
        const prev = await fetchLastSnapshotValue(interaction.guildId, interaction.user.id);
        if (prev !== null && !FANS_EDIT_ALLOW_DECREASE && value < prev) {
          return interaction.reply({ content: `設定により小さい値での訂正は許可されていません。`, ephemeral: true });
        }

        const result = await insertSnapshotAndUpsertMonthly(interaction.guildId, interaction.user.id, value, 'corrected');
        fansLastInputAt.set(interaction.user.id, now);

        const embed = new EmbedBuilder()
          .setTitle('✏️ 訂正を反映しました')
          .setDescription(`**${result.monthKey} の記録**\nベース: ${result.base.toLocaleString()}\n最新: ${result.last.toLocaleString()}\n今月: **+${result.delta.toLocaleString()}**\n更新回数: ${result.updates}`);
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }
    }
  } catch (err) {
    console.error('interaction error:', err);
    // isRepliable が true ならエラーメッセージ（ephemeral）
    try {
      if ('isRepliable' in interaction && interaction.isRepliable()) {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.reply({ content: 'エラーが発生しました。', ephemeral: true });
        }
      }
    } catch {}
  }
});

/* ==============================
   定期削除タスク（auto_delete）
============================== */
setInterval(async () => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM auto_delete_messages WHERE delete_at <= $1',
      [Date.now()]
    );

    for (const row of rows) {
      try {
        const channel = await client.channels.fetch(row.channel_id);
        if (!channel) continue;
        const msg = await channel.messages.fetch(row.message_id).catch(() => null);
        if (msg) await msg.delete().catch(() => {});
      } finally {
        await pool.query('DELETE FROM auto_delete_messages WHERE message_id=$1', [row.message_id]);
      }
    }
  } catch (err) {
    console.error('定期削除エラー:', err);
  }
}, 60 * 1000); // 1分ごと

/* ==============================
   Bot ログイン
============================== */
client.login(process.env.DISCORD_TOKEN);
