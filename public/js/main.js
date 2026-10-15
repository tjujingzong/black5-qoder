// 入口：首页交互 + 房间实时连接装配。
import { createRoom, RoomNet } from './net.js?v=20261012g';
import { init as initUI, render, bindSend, toast, setRoomInfo, showInteraction } from './ui.js?v=20261012g';
import { gameAudio } from './audio.js?v=20261012g';
import { VoiceChat } from './voice.js?v=20261012g';

const $ = selector => document.querySelector(selector);
initUI();
gameAudio.init();

const params = new URLSearchParams(location.search);
if (params.get('room')) $('#inp-code').value = params.get('room').toUpperCase().slice(0, 5);
$('#inp-name').value = sessionStorage.getItem('jh5-name') || '';

let roomNet = null;
let currentRoom = null;
let retryCount = 0;
const voiceChat = new VoiceChat({
  upload: payload => roomNet ? roomNet.voiceUpload(payload) : Promise.resolve(null),
  poll: since => roomNet ? roomNet.voicePoll(since) : Promise.resolve(null),
  onState({ listening, speaking, busy }) {
    const button = $('#btn-voice');
    button.disabled = busy;
    button.classList.toggle('active', speaking);
    button.setAttribute('aria-pressed', String(speaking));
    const icon = button.querySelector('span');
    if (icon) icon.textContent = speaking ? '🎙' : '🎤';
    else button.textContent = speaking ? '🎙' : '🎤';
    // 开麦=说话；未开麦时仍在"听"（进入房间自动收听，无需麦克风）
    let label;
    if (busy) label = '正在开麦…';
    else if (speaking) label = '开麦中 · 闭麦';
    else label = listening ? '开麦说话（听已开启）' : '开麦说话';
    button.setAttribute('aria-label', label);
    button.title = label;
  },
  onError: message => toast(message),
});

$('#btn-voice').addEventListener('click', () => voiceChat.toggle().catch(error => {
  toast(`语音启动失败（${error?.name || 'UnknownError'}）`);
}));

function setSender(fn) {
  bindSend(fn);
}

function showRoom() {
  $('#screen-home').classList.add('hidden');
  $('#screen-room').classList.remove('hidden');
}

function setCreateBusy(busy, label = '创建房间') {
  $('#btn-create').disabled = busy;
  $('#btn-create').textContent = busy ? label : '创建房间';
}

function setJoinBusy(busy, label = '加入房间') {
  $('#btn-join').disabled = busy;
  $('#btn-join').textContent = busy ? label : '加入房间';
}

function resetHomeButtons() {
  setCreateBusy(false);
  setJoinBusy(false);
}

function connectRoom(code, name, token) {
  if (roomNet) {
    voiceChat.onDisconnected();
    roomNet.destroy();
  }
  currentRoom = { code, name, token };

  const net = new RoomNet({
    onWelcome(data) {
      if (roomNet !== net) return;
      retryCount = 0;
      currentRoom.token = data.token;
      sessionStorage.setItem('jh5-token-' + code, data.token);
      localStorage.setItem('jh5-token-' + code, data.token);
      setSender(message => {
        if (!net.send(message)) toast('连接尚未恢复，请稍后再试');
      });
      setRoomInfo(code);
      voiceChat.onConnected();
      resetHomeButtons();
      showRoom();
    },
    onState(view) {
      if (roomNet === net) {
        gameAudio.observe(view);
        render(view);
        showInteraction(view.lastInteraction);
        voiceChat.update(view);
      }
    },
    onVoiceChunk(message) {
      if (roomNet === net) voiceChat.handleChunk(message);
    },
    onError(message) {
      if (roomNet === net) {
        gameAudio.play('error');
        toast(message);
      }
    },
    onClose({ rejected }) {
      if (roomNet !== net) return;
      voiceChat.onDisconnected();
      if (rejected) {
        resetHomeButtons();
        return;
      }
      if (retryCount >= 10) {
        toast('重连失败，请刷新页面重新加入');
        resetHomeButtons();
        return;
      }
      retryCount++;
      toast(`连接断开，正在重连（${retryCount}/10）…`);
      setTimeout(() => {
        if (roomNet === net && currentRoom) {
          connectRoom(currentRoom.code, currentRoom.name, currentRoom.token);
        }
      }, Math.min(5000, 700 + retryCount * 500));
    },
  });
  roomNet = net;
  net.connect(code, name, token);
}

$('#btn-create').addEventListener('click', async () => {
  const name = $('#inp-name').value.trim();
  if (!name) return toast('请先输入昵称');
  sessionStorage.setItem('jh5-name', name);
  setCreateBusy(true, '创建中…');
  try {
    const room = await createRoom(name);
    retryCount = 0;
    connectRoom(room.code, name, room.token);
    toast('正在进入房间…');
  } catch (e) {
    toast(e.message || '创建房间失败');
    setCreateBusy(false);
  }
});

$('#btn-join').addEventListener('click', () => {
  const name = $('#inp-name').value.trim();
  const code = $('#inp-code').value.trim().toUpperCase();
  if (!name) return toast('请先输入昵称');
  if (!/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/.test(code)) {
    return toast('请输入正确的 5 位房间号');
  }
  sessionStorage.setItem('jh5-name', name);
  const token = sessionStorage.getItem('jh5-token-' + code)
    || localStorage.getItem('jh5-token-' + code) || null;
  retryCount = 0;
  setJoinBusy(true, '连接中…');
  connectRoom(code, name, token);
  toast('正在连接房间…');
});

$('#btn-leave').addEventListener('click', () => {
  if (confirm('确定要离开房间吗？')) location.href = location.pathname;
});
