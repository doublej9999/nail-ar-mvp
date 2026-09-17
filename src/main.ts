import * as THREE from 'three';
import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from '@mediapipe/tasks-vision';
import './style.css';

const video = document.querySelector<HTMLVideoElement>('#camera')!;
video.hidden = true;
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
let selectedDesign = 'blush';
const designPicker = document.querySelector<HTMLElement>('#design-picker')!;
const photoMaterials: THREE.MeshPhysicalMaterial[] = [];
const photoTextures: (THREE.Texture | null)[] = Array(5).fill(null);
const photoCrops = [
  [96, 136, 226, 359], [239, 137, 356, 327], [350, 130, 465, 319],
  [463, 114, 575, 301], [566, 117, 675, 288],
];
new THREE.TextureLoader().load('/nail-reference.jpg', image => {
  photoCrops.forEach(([x1, y1, x2, y2], i) => {
    const crop = document.createElement('canvas'); crop.width = x2 - x1; crop.height = y2 - y1;
    crop.getContext('2d')!.drawImage(image.image, x1, y1, crop.width, crop.height, 0, 0, crop.width, crop.height);
    const texture = new THREE.CanvasTexture(crop); texture.colorSpace = THREE.SRGBColorSpace;
    photoTextures[i] = texture;
    if (photoMaterials[i]) { photoMaterials[i].map = texture; photoMaterials[i].needsUpdate = true; }
  });
});

const designThemes: Record<string, { colors: number[]; accent: number; stripe: boolean; photo: boolean }> = {
  // Crops correspond to the five decorated nails in the supplied reference.
  blush: { colors: [0xc98286, 0xe7b6a5, 0xd89aa7, 0xb96f83, 0xe6c2b8], accent: 0xffd69a, stripe: false, photo: true },
  french: { colors: [0xf7e9df, 0xf7e9df, 0xf7e9df, 0xf7e9df, 0xf7e9df], accent: 0xffffff, stripe: false, photo: false },
  berry: { colors: [0x9d285c, 0xc83c72, 0x8d245d, 0xe06c98, 0x7b194e], accent: 0xffbdd6, stripe: true, photo: false },
  midnight: { colors: [0x25255f, 0x34347d, 0x20204e, 0x41469a, 0x292964], accent: 0xffe7a4, stripe: true, photo: false },
};
let smoothedHandScale = 1;
let lastHandScale = 1;
const palmReferenceWidth = 0.22;

function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }

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
function createDesignerNail(index: number) {
  const group = new THREE.Group();
  // Almond-shaped glossy shell: wider near the cuticle, tapered at the tip.
  const outline = new THREE.Shape();
  outline.moveTo(-0.065, -0.13); outline.quadraticCurveTo(-0.10, 0.02, 0, 0.16);
  outline.quadraticCurveTo(0.10, 0.02, 0.065, -0.13); outline.closePath();
  const geo = new THREE.ExtrudeGeometry(outline, { depth: 0.028, bevelEnabled: true, bevelSegments: 3, bevelSize: 0.012, bevelThickness: 0.012, curveSegments: 12 });
  geo.center();
  const palette = [0xc98286, 0xe7b6a5, 0xd89aa7, 0xb96f83, 0xe6c2b8];
  const mat = new THREE.MeshPhysicalMaterial({ color: palette[index], roughness: 0.14, metalness: 0.08, clearcoat: 1, clearcoatRoughness: 0.05, sheen: 0.5, sheenColor: 0xffd8dd });
  mat.map = photoTextures[index];
  if (mat.map) mat.needsUpdate = true;
  photoMaterials[index] = mat;
  const nail = new THREE.Mesh(geo, mat);
  nail.rotation.x = Math.PI / 2; group.add(nail);
  // A tiny gold shimmer stripe gives the set a finished salon look.
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.20, 0.003), new THREE.MeshBasicMaterial({ color: 0xffd69a, transparent: true, opacity: 0.8 }));
  stripe.position.set(0.022, 0, 0.02); stripe.rotation.z = index % 2 ? -0.18 : 0.18; group.add(stripe);
  group.visible = false; nailGroup.add(group); return group;
}
const nails = Array.from({ length: 5 }, (_, i) => createDesignerNail(i));

function applyDesign(name: string) {
  const theme = designThemes[name] ?? designThemes.blush;
  selectedDesign = name;
  nails.forEach((group, i) => {
    const shell = group.children[0] as THREE.Mesh;
    const material = shell.material as THREE.MeshPhysicalMaterial;
    material.color.setHex(theme.colors[i]);
    material.map = theme.photo ? photoTextures[i] : null;
    material.needsUpdate = true;
    const accent = group.children[1] as THREE.Mesh;
    (accent.material as THREE.MeshBasicMaterial).color.setHex(theme.accent);
    accent.visible = theme.stripe;
  });
  document.querySelectorAll('.design').forEach(button => button.classList.toggle('active', (button as HTMLElement).dataset.design === name));
}

designPicker.querySelectorAll<HTMLButtonElement>('.design').forEach(button => {
  button.addEventListener('click', () => applyDesign(button.dataset.design ?? 'blush'));
});
applyDesign(selectedDesign);

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
    // Show the live stream before loading the ML model. A slow/unsupported
    // model must not make the camera appear to have failed.
    video.hidden = false;
    video.classList.add('camera-live');
    video.style.display = 'block';
    video.srcObject = stream;
    startPanel.hidden = true; hud.hidden = false; controls.hidden = false; designPicker.hidden = false;
    statusEl.textContent = '正在开启摄像头…';
    try {
      await video.play();
    } catch (error) {
      // Safari can reject play() while it is switching the MediaStream. The
      // stream is still usable; only abort errors are safe to ignore here.
      if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
    }
    await new Promise<void>((resolve, reject) => {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return resolve();
      const timer = window.setTimeout(() => reject(new Error('摄像头视频流未能准备就绪')), 5000);
      video.addEventListener('canplay', () => { window.clearTimeout(timer); resolve(); }, { once: true });
    });
    statusEl.textContent = '正在加载手部识别…';
    try {
      await initLandmarker();
      cancelAnimationFrame(raf); raf = requestAnimationFrame(loop);
    } catch (error) {
      statusEl.textContent = '相机已开启 · 手部识别加载失败';
      errorEl.textContent = `相机已开启，但识别模型加载失败：${error instanceof Error ? error.message : '请检查网络后刷新'}`;
      errorEl.hidden = false;
    }
  } catch (error) {
    stream?.getTracks().forEach(t => t.stop()); stream = null; video.srcObject = null; video.classList.remove('camera-live'); video.style.display = 'none'; video.hidden = true;
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
  if (!points) {
    nails.forEach(n => n.visible = false);
    nailGroup.scale.setScalar(lastHandScale);
    statusEl.textContent = '未识别到手部';
    return;
  }
  // The sign is mirrored to match the front-facing display transform.
  const backOfHand = handDirection(points) < 0;
  const tips = [4, 8, 12, 16, 20], dips = [3, 7, 11, 15, 19];
  // Do not scale the parent group: scaling it also scales the world-space
  // positions and causes visible drift during approach/retreat. Size each
  // nail from its own DIP→tip segment instead.
  nails.forEach((nail, i) => {
    nail.visible = backOfHand;
    if (!backOfHand) return;
    const tip = points[tips[i]], dip = points[dips[i]];
    const fingerLength = Math.hypot(tip.x - dip.x, tip.y - dip.y, tip.z - dip.z);
    // The distal segment is a more reliable scale reference than palm width:
    // it makes each nail fit its own finger and avoids parent-group drift.
    const nailScale = clamp(fingerLength / 0.16, 0.68, 1.65);
    nail.scale.lerp(new THREE.Vector3(nailScale, nailScale, nailScale), 0.20);
    const direction = new THREE.Vector3(tip.x - dip.x, -(tip.y - dip.y), -(tip.z - dip.z)).normalize();
    const nailCenter = {
      x: dip.x + (tip.x - dip.x) * 0.58,
      y: dip.y + (tip.y - dip.y) * 0.58,
      z: dip.z + (tip.z - dip.z) * 0.58,
    };
    // Center on the actual nail bed (between DIP and fingertip), rather than
    // offsetting from the tip. This keeps the cuticle covered while zooming.
    const target = new THREE.Vector3((nailCenter.x - 0.5) * 1.9, (0.5 - nailCenter.y) * 1.45, -nailCenter.z * 1.2);
    nail.position.lerp(target, 0.24);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    nail.quaternion.slerp(q, 0.22);
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
document.querySelector('#stop-button')!.addEventListener('click', () => { cancelAnimationFrame(raf); stream?.getTracks().forEach(t => t.stop()); stream = null; video.srcObject = null; video.classList.remove('camera-live'); video.style.display = 'none'; video.hidden = true; nails.forEach(n => n.visible = false); hud.hidden = true; controls.hidden = true; designPicker.hidden = true; startPanel.hidden = false; });
(window as Window & { __appReady?: boolean }).__appReady = true;
