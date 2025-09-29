import 'dotenv/config';
import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pkg from 'pg';
import express from 'express'; // ← 追加
const { Pool } = pkg;

// ==== Discord Client ====
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
const AUTO_ROLE_ID = process.env.AUTO_ROLE_ID;
const AUTO_DELETE_CHANNEL_ID = process.env.AUTO_DELETE_CHANNEL_ID;
const NICKNAME_CHANNEL_ID = process.env.NICKNAME_CHANNEL_ID;
const PORT = process.env.PORT || 10000; // Render がチェックするポート

// ==== Neon/PostgreSQL ====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ==== 集計ボタン ====
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

// ==== DB操作 ====
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
const userButtonMessages = new Map(); // ユーザー専用ボタン

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

// ==== Bot起動 ====
client.once('ready', () => {
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

  // ニックネーム変更・復帰は特定チャンネルのみ
  if (![NICKNAME_CHANNEL_ID, AUTO_DELETE_CHANNEL_ID, COUNT_CHANNEL_ID].includes(message.channel.id)) return;

  // ニックネーム変更
  if (message.channel.id === NICKNAME_CHANNEL_ID && message.mentions.has(client.user) && message.content.includes('切れ者')) {
    const oldNick = member.nickname || member.user.username;
    let userCounts = await loadCount(member.id);
    userCounts.nickname_changes = (userCounts.nickname_changes || 0) + 1;
    const newNick = `切れ者確率${Math.floor(Math.random() * 121)}%`;
    await member.setNickname(newNick).catch(console.error);

    await saveCount(member.id, userCounts);

    await message.channel.send(
      `**お前は${userCounts.nickname_changes}回目の入浴だねぇ。\nフン。ようやく準備ができたのかい。\n変更前のニックネームというのかい。贅沢な名だねぇ。\n今からお前の名は${newNick}だ。\nいいかい？${newNick}だ。\n分かったら返事をするんだ、${newNick}！！\n${randomReplies[Math.floor(Math.random()*randomReplies.length)]}**`
    );

    await sendOrUpdateButtons(message.channel, member.id, userCounts);
    return;
  }

  // バルス（全員リセット）
  if (message.channel.id === COUNT_CHANNEL_ID && message.mentions.has(client.user) && message.content.includes('バルス')) {
    await resetAllCounts();
    for (const [userId, _] of userButtonMessages.entries()) {
      await sendOrUpdateButtons(message.channel, userId, { kiremono:0, ritaiya:0, kirenashi:0, nickname_changes:0 });
    }
    await message.channel.send('**全員の集計をリセットしました！**');
    return;
  }

  // ニックネーム復帰
  if (message.channel.id === NICKNAME_CHANNEL_ID && message.attachments.size > 0) {
    const oldNick = member.nickname?.match(/切れ者確率\d+%/) ? member.user.username : member.nickname;
    if (oldNick) {
      await member.setNickname(oldNick).catch(console.error);
      await message.channel.send('**それがお前の答えかい？\nいきな！\nお前の勝ちだ！\n早くいっちまいな！！\nフン！**');
      if (userButtonMessages.has(member.id)) {
        await userButtonMessages.get(member.id).delete().catch(console.error);
        userButtonMessages.delete(member.id);
      }
    }
  }

  // 自動削除（24時間後）
  if (message.channel.id === AUTO_DELETE_CHANNEL_ID) {
    setTimeout(async () => {
      if (!message.deleted) {
        await message.delete().catch(console.error);
      }
    }, 24 * 60 * 60 * 1000);
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

  let userCounts = await loadCount(userId);
  userCounts[key] += 1;
  await saveCount(userId, userCounts);

  await sendOrUpdateButtons(interaction.channel, userId, userCounts);

  const reply = randomReplies[Math.floor(Math.random() * randomReplies.length)];
  await interaction.reply({ content: `**${BUTTON_LABELS[key]} ${userCounts[key]}回目！ ${reply}**`, ephemeral: true });
});

// ==== Render 用ダミー Web サーバー ====
const app = express();
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(PORT, () => console.log(`HTTP server listening on port ${PORT}`));

// ==== Botログイン ====
client.login(process.env.DISCORD_TOKEN);
