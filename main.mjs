import 'dotenv/config';
import { Client, GatewayIntentBits, Events, bold } from 'discord.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;

// 変更前ニックネームを保存するマップ
const nicknameMap = new Map();

// --- 起動 ---
client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// --- メッセージ監視 ---
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== TARGET_CHANNEL_ID) return;

  // Botへのメンションだけを検出
  const isBotMentioned =
    message.mentions.has(client.user) && message.mentions.users.size === 1;

  // ニックネーム変更処理
  if (isBotMentioned && message.content.includes('切れ者')) {
    const member = message.member;
    if (!member) return;

    // ランダムで1〜120%
    const rate = Math.floor(Math.random() * 120) + 1;
    const oldNick = member.nickname || member.user.username;
    const newNick = `切れ者確率${rate}%`;

    // 変更前を記録
    nicknameMap.set(member.id, oldNick);

    try {
      await member.setNickname(newNick);

      const replyText = bold(
        `フン。ようやく準備ができたのかい。\n` +
        `${oldNick}というのかい。贅沢な名だねぇ。\n` +
        `今からお前の名は${newNick} だ。\n` +
        `いいかい？${newNick}だ。\n` +
        `分かったら返事をするんだ、${newNick}！！`
      );

      await message.channel.send(replyText);
    } catch (err) {
      console.error(err);
      message.channel.send('ニックネーム変更に失敗しました。権限を確認してください。');
    }
  }

  // 画像投稿で元に戻す処理
  else if (
    nicknameMap.has(message.author.id) &&
    message.attachments.size > 0
  ) {
    const member = message.member;
    if (!member) return;

    const oldNick = nicknameMap.get(message.author.id);
    nicknameMap.delete(message.author.id);

    try {
      await member.setNickname(oldNick);
      const replyText = bold(
        `それがお前の答えかい？\n` +
        `いきな！\n` +
        `お前の勝ちだ！\n` +
        `早くいっちまいな！！\n` +
        `フン！`
      );
      await message.channel.send(replyText);
    } catch (err) {
      console.error(err);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
