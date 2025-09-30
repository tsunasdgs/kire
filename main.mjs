import 'dotenv/config';
import express from 'express';
import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pkg from 'pg';
const { Pool } = pkg;

// ==== Express Web Server (Render 用) ====
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));

// ==== Discord Bot 初期化 ====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// ==== 環境変数 ====
const COUNT_CHANNEL_ID = process.env.COUNT_CHANNEL_ID;
const NICKNAME_CHANNEL_ID = process.env.NICKNAME_CHANNEL_ID;
const AUTO_DELETE_CHANNEL_ID = process.env.AUTO_DELETE_CHANNEL_ID;
const AUTO_ROLE_ID = process.env.AUTO_ROLE_ID;

// ==== DB 接続 ====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ==== 初回起動時に必要テーブルを作成 ====
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS counts (
      user_id BIGINT PRIMARY KEY,
      kiremono INTEGER DEFAULT 0,
      ritaiya INTEGER DEFAULT 0,
      kirenashi INTEGER DEFAULT 0,
      nickname_changes INTEGER DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS auto_delete_messages (
      message_id BIGINT PRIMARY KEY,
      channel_id BIGINT NOT NULL,
      delete_at BIGINT NOT NULL
    )
  `);
}

// ==== 集計ボタン・ランダム返信 ====
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

// ==== DB 操作 ====
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

// ==== ボタン管理 ====
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

// ==== Bot 起動 ====
client.once('ready', async () => {
  await initDB();
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// ==== 自動ロール付与 ====
client.on('guildMemberAdd', async member => {
  if (AUTO_ROLE_ID) {
    const role = member.guild.roles.cache.get(AUTO_ROLE_ID);
    if (role) await member.roles.add(role).catch(console.error);
  }
});

// ==== メッセージ監視 ====
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  const member = message.member;

  // ニックネ変更チャンネル
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
      for (const [userId, _] of userButtonMessages.entries()) {
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

// ==== ボタン押下 ====
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  const key = interaction.customId;
  if (!WORD_BUTTONS.includes(key)) return;

  const userId = interaction.user.id;
  if (interaction.message.id !== userButtonMessages.get(userId)?.id) {
    await interaction.reply({ content: 'これはあなたのボタンではありません。', ephemeral: true });
    return;
  }

  const userCounts = await loadCount(userId);
  userCounts[key] += 1;
  await saveCount(userId, userCounts);

  await sendOrUpdateButtons(interaction.channel, userId, userCounts);

  const reply = randomReplies[Math.floor(Math.random() * randomReplies.length)];
  await interaction.reply({ content: `**${BUTTON_LABELS[key]} ${userCounts[key]}回目！ ${reply}**`, ephemeral: true });
});

// ==== 定期削除タスク（1分ごと） ====
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

// ==== Bot ログイン ====
client.login(process.env.DISCORD_TOKEN);
