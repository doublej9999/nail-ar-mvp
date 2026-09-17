import * as THREE from 'three';
import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from '@mediapipe/tasks-vision';
import './style.css';

const video = document.querySelector<HTMLVideoElement>('#camera')!;
const canvas = document.querySelector<HTMLCanvasElement>('#ar-canvas')!;
const startPanel = document.querySelector<HTMLElement>('#start-panel')!;
const hud = document.querySelector<HTMLElement>('#hud')!;
const controls = document.querySelector<HTMLElement>('#controls')!;
const statusEl = document.querySelector<HTMLElement>('#status')!;
const fpsEl = document.querySelector<HTMLElement>('#fps')!;
const errorEl = document.querySelector<HTMLElement>('#error')!;

let stream: MediaStream | null = null;
let landmarker: HandLandmarker | null = null;
let raf = 0;
let lastVideoTime = -1;
let frames = 0;
let fpsStamp = performance.now();
let facingMode: 'environment' | 'user' = 'environment';

const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 10);
camera.position.set(0, 0, 3.2);
scene.add(new THREE.HemisphereLight(0xffe9e1, 0x171827, 2.5));
const keyLight = new THREE.DirectionalLight(0xffffff, 3.2);
keyLight.position.set(-1, 2, 3); scene.add(keyLight);

const nailGroup = new THREE.Group(); scene.add(nailGroup);
const nails = Array.from({ length: 5 }, (_, i) => {
  const group = new THREE.Group();
  const shape = new THREE.CapsuleGeometry(0.075, 0.18, 8, 16);
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color().setHSL(0.02 + i * 0.012, 0.45, 0.72),
    roughness: 0.18, metalness: 0.04, clearcoat: 1, clearcoatRoughness: 0.08,
  });
  const nail = new THREE.Mesh(shape, material);
  nail.rotation.x = Math.PI / 2; group.add(nail); group.visible = false;
  nailGroup.add(group); return group;
});

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize); resize();

const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
// Pin the package assets to the same-origin Vite public path when deployed.
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';

function cameraErrorMessage(error: unknown) {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return '相机权限被拒绝，请在浏览器设置中允许本网站使用相机。';
  if (name === 'NotFoundError') return '没有可用摄像头。请用手机 Safari 或 Chrome 打开，不要使用 Telegram 内置浏览器。';
  if (name === 'NotReadableError') return '摄像头被其他应用占用，请关闭微信/相机等应用后重试。';
  if (name === 'OverconstrainedError') return '当前摄像头不支持该模式，正在使用通用模式失败。';
  return error instanceof Error ? `启动失败：${error.message}` : '启动失败，请刷新页面后重试。';
}

async function initLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  const options = {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' as const },
    runningMode: 'VIDEO' as const, numHands: 1,
    minHandDetectionConfidence: 0.55, minHandPresenceConfidence: 0.55, minTrackingConfidence: 0.55,
  };
  try {
    landmarker = await HandLandmarker.createFromOptions(vision, options);
  } catch {
    // Some iOS WebViews and older Android GPUs cannot initialize WebGL.
    landmarker = await HandLandmarker.createFromOptions(vision, { ...options, baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' as const } });
  }
}



async function startCamera() {
  errorEl.hidden = true;
  stream?.getTracks().forEach(t => t.stop());
  try {
    const preferred = { video: { facingMode: { exact: facingMode }, width: { ideal: 640, max: 1280 }, height: { ideal: 480, max: 720 } }, audio: false };
    try {
      stream = await navigator.mediaDevices.getUserMedia(preferred);
    } catch (firstError) {
      // A few browsers reject facingMode constraints even when a camera exists.
      if (firstError instanceof DOMException && (firstError.name === 'OverconstrainedError' || firstError.name === 'NotFoundError')) {
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640, max: 1280 }, height: { ideal: 480, max: 720 } }, audio: false });
      } else throw firstError;
    }
    video.srcObject = stream; await video.play();
    await new Promise<void>(resolve => video.readyState >= 2 ? resolve() : video.addEventListener('loadeddata', () => resolve(), { once: true }));
    video.style.display = 'block'; startPanel.hidden = true; hud.hidden = false; controls.hidden = false;
    statusEl.textContent = '正在加载手部识别…';
    await initLandmarker(); cancelAnimationFrame(raf); raf = requestAnimationFrame(loop);
  } catch (error) {
    stream?.getTracks().forEach(t => t.stop()); stream = null;
    errorEl.textContent = cameraErrorMessage(error);
    errorEl.hidden = false;
  }
}

function handDirection(points: { x: number; y: number; z: number }[]) {
  const a = new THREE.Vector3(points[5].x, points[5].y, points[5].z);
  const b = new THREE.Vector3(points[17].x, points[17].y, points[17].z);
  const wrist = new THREE.Vector3(points[0].x, points[0].y, points[0].z);
  const normal = new THREE.Vector3().crossVectors(a.clone().sub(wrist), b.clone().sub(wrist));
  return normal.z;
}

function updateNails(result: HandLandmarkerResult) {
  const points = result.landmarks[0];
  if (!points) { nails.forEach(n => n.visible = false); statusEl.textContent = '未识别到手部'; return; }
  // The sign is mirrored to match the front-facing display transform.
  const backOfHand = handDirection(points) < 0;
  const tips = [4, 8, 12, 16, 20], dips = [3, 7, 11, 15, 19];
  nails.forEach((nail, i) => {
    nail.visible = backOfHand;
    if (!backOfHand) return;
    const tip = points[tips[i]], dip = points[dips[i]];
    const target = new THREE.Vector3((0.5 - tip.x) * 1.9, (0.5 - tip.y) * 1.45, -tip.z * 1.2);
    nail.position.lerp(target, 0.3);
    const direction = new THREE.Vector3(tip.x - dip.x, -(tip.y - dip.y), -(tip.z - dip.z)).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    nail.quaternion.slerp(q, 0.3);
  });
  statusEl.textContent = backOfHand ? '已识别 · 手背模式' : '检测到手心 · 请翻转手背';
}

function loop() {
  if (video.readyState >= 2 && landmarker && video.currentTime !== lastVideoTime) {
    const result = landmarker.detectForVideo(video, performance.now()); updateNails(result); lastVideoTime = video.currentTime;
    frames++;
  }
  const now = performance.now();
  if (now - fpsStamp > 1000) { fpsEl.textContent = `${frames} FPS`; frames = 0; fpsStamp = now; }
  renderer.render(scene, camera); raf = requestAnimationFrame(loop);
}

document.querySelector('#start-button')!.addEventListener('click', startCamera);
document.querySelector('#switch-camera')!.addEventListener('click', () => { facingMode = facingMode === 'environment' ? 'user' : 'environment'; startCamera(); });
document.querySelector('#stop-button')!.addEventListener('click', () => { cancelAnimationFrame(raf); stream?.getTracks().forEach(t => t.stop()); stream = null; video.srcObject = null; video.style.display = 'none'; nails.forEach(n => n.visible = false); hud.hidden = true; controls.hidden = true; startPanel.hidden = false; });
(window as Window & { __appReady?: boolean }).__appReady = true;
