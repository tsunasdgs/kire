import 'dotenv/config';
import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events } from 'discord.js';
import pkg from 'pg';
const { Pool } = pkg;

// ===== DB =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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
  if (rows.length === 0) return { kiremono:0, ritaiya:0, kirenashi:0, nicknameChanges:0 };
  const r = rows[0];
  return {
    kiremono: r.kiremono,
    ritaiya: r.ritaiya,
    kirenashi: r.kirenashi,
    nicknameChanges: r.nickname_changes,
  };
}

// ===== Bot =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ]
});

const COUNT_CHANNEL_ID = process.env.COUNT_CHANNEL_ID;
const AUTO_DELETE_CHANNEL_ID = process.env.AUTO_DELETE_CHANNEL_ID;
const AUTO_ROLE_ID = process.env.AUTO_ROLE_ID;

const userWordCounts = {};
const renameMap = new Map();

// ===== 起動時 =====
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// ===== 新規参加者にロール付与 =====
client.on('guildMemberAdd', async (member) => {
  if (!AUTO_ROLE_ID) return;
  const role = member.guild.roles.cache.get(AUTO_ROLE_ID);
  if (role) await member.roles.add(role);
});

// ===== メッセージ監視 =====
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // --- 自動削除 ---
  if (AUTO_DELETE_CHANNEL_ID && message.channel.id === AUTO_DELETE_CHANNEL_ID) {
    setTimeout(() => message.delete().catch(console.error), 24*60*60*1000);
  }

  // --- バルスで全員リセット ---
  if (message.mentions.has(client.user) && message.content.includes('バルス')) {
    if (!message.member.permissions.has('Administrator')) {
      await message.reply('管理者権限がないと全員リセットできません！');
      return;
    }

    const { rows } = await pool.query('SELECT user_id FROM counts');
    for (const row of rows) {
      await saveCount(row.user_id, { kiremono:0, ritaiya:0, kirenashi:0, nicknameChanges:0 });
    }

    const channel = message.channel;
    const fetched = await channel.messages.fetch({ limit: 100 });
    const toDelete = fetched.filter(msg => !msg.author.bot);
    await channel.bulkDelete(toDelete, true).catch(console.error);

    await message.channel.send('全員リセット＆メッセージ削除完了！');
    return;
  }

  // --- ニックネーム変更 ---
  if (message.mentions.has(client.user) && message.content.includes('切れ者')) {
    const member = message.member;
    if (!member) return;
    const oldNick = member.nickname || member.user.username;
    const percent = Math.floor(Math.random()*121);
    const newNick = `切れ者確率${percent}%`;

    if (!userWordCounts[member.id]) userWordCounts[member.id] = await loadCount(member.id);
    userWordCounts[member.id].nicknameChanges += 1;
    await saveCount(member.id, userWordCounts[member.id]);
    await member.setNickname(newNick).catch(console.error);

    // ===== ボタン作成（2行レイアウト） =====
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('kiremono').setLabel('きれもの +1').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('ritaiya').setLabel('りたいあ +1').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('kirenashi').setLabel('きれなし +1').setStyle(ButtonStyle.Primary)
    );

    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('view_count').setLabel('集計を見る').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('reset_self').setLabel('リセット').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('reset_all').setLabel('全員リセット').setStyle(ButtonStyle.Secondary)
    );

    const buttonMessage = await message.channel.send({
      content: `**${member.displayName} のニックネームを変更しました！ボタンで操作できます**`,
      components: [row1, row2]
    });

    renameMap.set(member.id, { oldNick, buttonMessage });
    return;
  }

  // --- ニックネーム戻し ---
  if (renameMap.has(message.author.id) && message.attachments.size > 0) {
    const member = message.member;
    const { oldNick, buttonMessage } = renameMap.get(message.author.id);
    await member.setNickname(oldNick).catch(console.error);

    if (buttonMessage && !buttonMessage.deleted) {
      await buttonMessage.delete().catch(console.error);
    }

    renameMap.delete(message.author.id);
    await message.channel.send('ニックネームを元に戻しました！');
    return;
  }
});

// ===== ボタンクリック処理 =====
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  const uid = interaction.user.id;
  if (!userWordCounts[uid]) userWordCounts[uid] = await loadCount(uid);

  switch (interaction.customId) {
    case 'kiremono':
      userWordCounts[uid].kiremono += 1;
      await saveCount(uid, userWordCounts[uid]);
      await interaction.reply({ content: 'きれものカウント +1', ephemeral: true });
      break;
    case 'ritaiya':
      userWordCounts[uid].ritaiya += 1;
      await saveCount(uid, userWordCounts[uid]);
      await interaction.reply({ content: 'りたいあカウント +1', ephemeral: true });
      break;
    case 'kirenashi':
      userWordCounts[uid].kirenashi += 1;
      await saveCount(uid, userWordCounts[uid]);
      await interaction.reply({ content: 'きれなしカウント +1', ephemeral: true });
      break;
    case 'view_count':
      const c = userWordCounts[uid];
      const total = c.kiremono + c.ritaiya + c.kirenashi;
      await interaction.reply({
        content: `**あなたの集計結果**\nきれもの: ${c.kiremono}\nりたいあ: ${c.ritaiya}\nきれなし: ${c.kirenashi}\n合計: ${total}`,
        ephemeral: true
      });
      break;
    case 'reset_self':
      userWordCounts[uid] = { kiremono:0, ritaiya:0, kirenashi:0, nicknameChanges:0 };
      await saveCount(uid, userWordCounts[uid]);
      await interaction.reply({ content: 'あなたの集計をリセットしました！', ephemeral: true });
      break;
    case 'reset_all':
      await interaction.reply({ content: '全員リセットはボタンからは実行できません。@Bot バルスで実行してください。', ephemeral: true });
      break;
  }
});

client.login(process.env.DISCORD_TOKEN);
