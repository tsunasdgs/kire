import 'dotenv/config';
import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import express from 'express';
import pkg from 'pg';

const { Pool } = pkg;

// ====== PostgreSQL Pool ======
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ====== DB操作 ======
async function saveCount(userId, counts) {
  await pool.query(
    `INSERT INTO counts (user_id, kiremono, ritaiya, kirenashi, nickname_changes)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id)
     DO UPDATE SET kiremono=$2, ritaiya=$3, kirenashi=$4, nickname_changes=$5`,
    [userId, counts.kiremono, counts.ritaiya, counts.kirenashi, counts.nicknameChanges]
  );
}

async function loadCount(userId) {
  const { rows } = await pool.query('SELECT * FROM counts WHERE user_id=$1', [userId]);
  if (!rows.length) return { kiremono:0, ritaiya:0, kirenashi:0, nicknameChanges:0 };
  const r = rows[0];
  return { kiremono: r.kiremono, ritaiya: r.ritaiya, kirenashi: r.kirenashi, nicknameChanges: r.nickname_changes };
}

async function resetAllCounts() {
  await pool.query('UPDATE counts SET kiremono=0, ritaiya=0, kirenashi=0, nickname_changes=0');
}

// ====== Discord Bot ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const BUTTON_CHANNEL_ID = process.env.BUTTON_CHANNEL_ID;
const AUTO_DELETE_CHANNEL_ID = process.env.AUTO_DELETE_CHANNEL_ID;
const AUTO_ROLE_ID = process.env.AUTO_ROLE_ID;

const userWordCounts = {};
const renameMap = new Map();
const messageTimers = new Map();

const randomReplies = [
  '窓をお開け！全部だよ！！',
  'やはり！さぁ、きばるんだよ！',
  'んん……？？',
  'ヒッ！？',
  'うるさいね、静かにしておくれ。',
  'だァーーーまァーーーれェーーー！！！',
  '大きな声を出すんじゃない……うっ！あー、ちょっと待ちなさい、ね、ねぇ～。',
  'フン！',
  'なぁんだいおまえ。生きてたのかい。',
  'ずいぶん生意気な口を利くね。いつからそんなに偉くなったんだい？',
  'あぁああごめんごめん、いい子でおねんねしてたのにねぇ。',
  '四の五の言うと、石炭にしちまうよ。わかったね！',
  'んん……？まだまだだねぇ。',
  'いい子だから、ほぉらほら～。',
  'フフフ、そんなことでは驚かないよ。',
];

// ====== ボタン生成 ======
async function sendUserButtonMessage(user) {
  const channel = client.channels.cache.get(BUTTON_CHANNEL_ID);
  if (!channel) return;

  // 古い本人ボタンは削除して最前列
  const messages = await channel.messages.fetch({ limit: 50 });
  messages.forEach(msg => {
    if (msg.author.id === client.user.id && msg.content.includes(`${user.username} さんのボタンです`)) {
      msg.delete().catch(() => {});
    }
  });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`kiremono_${user.id}`).setLabel('きれもの').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`ritaiya_${user.id}`).setLabel('りたいあ').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`kirenashi_${user.id}`).setLabel('きれなし').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`集計_${user.id}`).setLabel('集計を見る').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`リセット_${user.id}`).setLabel('リセット').setStyle(ButtonStyle.Danger)
  );

  await channel.send({ content: `${user.username} さんのボタンです`, components: [row] });
}

// ====== メッセージ自動削除 ======
function scheduleDelete(msg) {
  if (msg.channel.id !== AUTO_DELETE_CHANNEL_ID) return;
  const timer = setTimeout(() => {
    msg.delete().catch(() => {});
    messageTimers.delete(msg.id);
  }, 24 * 60 * 60 * 1000);
  messageTimers.set(msg.id, timer);
}

// ====== メッセージ処理 ======
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // --- バルスコマンド（全員リセット） ---
  if (message.mentions.has(client.user) && message.content.includes('バルス')) {
    await resetAllCounts();
    await message.channel.send('💥 バルス発動！サーバー全員の集計をリセットしました！');
    return;
  }

  // --- ニックネーム変更 ---
  if (message.mentions.has(client.user) && message.content.includes('切れ者')) {
    const member = message.member;
    if (!member) return;
    const oldNick = member.nickname || member.user.username;
    const percent = Math.floor(Math.random() * 121);
    const newNick = `切れ者確率${percent}%`;

    renameMap.set(member.id, oldNick);

    if (!userWordCounts[member.id]) userWordCounts[member.id] = await loadCount(member.id);
    userWordCounts[member.id].nicknameChanges += 1;
    await saveCount(member.id, userWordCounts[member.id]);

    await member.setNickname(newNick).catch(console.error);

    await message.channel.send(
      `**お前は${userWordCounts[member.id].nicknameChanges}回目の入浴だねぇ。**\n` +
      `**フン。ようやく準備ができたのかい。\n${oldNick}というのかい。贅沢な名だねぇ。\n` +
      `今からお前の名は${newNick} だ。\nいいかい？${newNick}だ。\n` +
      `分かったら返事をするんだ、${newNick}！！**`
    );

    sendUserButtonMessage(message.author);
  }

  // --- 画像投稿でニックネーム復元 ---
  if (renameMap.has(message.author.id) && message.attachments.size > 0) {
    const member = message.member;
    const oldNick = renameMap.get(message.author.id);
    await member.setNickname(oldNick).catch(console.error);
    renameMap.delete(message.author.id);

    // ボタン削除＆再生成
    const channel = client.channels.cache.get(BUTTON_CHANNEL_ID);
    if (channel) {
      const messages = await channel.messages.fetch({ limit: 50 });
      messages.forEach(msg => {
        if (msg.author.id === client.user.id && msg.content.includes(`${message.author.username} さんのボタンです`)) {
          msg.delete().catch(() => {});
        }
      });
      sendUserButtonMessage(message.author);
    }

    await message.channel.send('**それがお前の答えかい？\nいきな！\nお前の勝ちだ！\n早くいっちまいな！！\nフン！**');
  }

  // --- 自動削除スケジュール ---
  scheduleDelete(message);
});

// ====== ボタン押下処理 ======
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  const [action, uid] = interaction.customId.split('_');

  if (interaction.user.id !== uid) {
    await interaction.reply({ content: 'これはあなたのボタンではありません', ephemeral: true });
    return;
  }

  if (!userWordCounts[uid]) userWordCounts[uid] = await loadCount(uid);

  const reply = randomReplies[Math.floor(Math.random() * randomReplies.length)];

  if (['kiremono','ritaiya','kirenashi'].includes(action)) {
    userWordCounts[uid][action] += 1;
    await saveCount(uid, userWordCounts[uid]);
    await interaction.reply({ content: `**${action}をカウントしました！**\n${reply}`, ephemeral: true });
  }

  if (action === '集計') {
    const c = userWordCounts[uid];
    const total = c.kiremono + c.ritaiya + c.kirenashi;
    await interaction.reply({
      content: `**あなたの集計**\nきれもの: ${c.kiremono}\nりたいあ: ${c.ritaiya}\nきれなし: ${c.kirenashi}\n合計: ${total}\n\n${reply}`,
      ephemeral: true
    });
  }

  if (action === 'リセット') {
    userWordCounts[uid] = { kiremono:0, ritaiya:0, kirenashi:0, nicknameChanges:0 };
    await saveCount(uid, userWordCounts[uid]);
    await interaction.reply({ content: `集計をリセットしました。\n${reply}`, ephemeral: true });
  }
});

// ====== 新規参加ユーザー自動ロール付与 ======
client.on('guildMemberAdd', async (member) => {
  if (!AUTO_ROLE_ID) return;
  try {
    await member.roles.add(AUTO_ROLE_ID);
    console.log(`✅ ${member.user.tag} に自動ロールを付与しました`);
  } catch (err) {
    console.error('❌ 自動ロール付与失敗:', err);
  }
});

// ====== Bot起動 ======
client.once('clientReady', () => console.log(`✅ Logged in as ${client.user.tag}`));
client.login(process.env.DISCORD_TOKEN);

// ====== Render用ダミーサーバー ======
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (_, res) => res.send('Discord bot is running!'));
app.listen(PORT, () => console.log(`🌐 HTTP server listening on port ${PORT}`));
