/* Synapse 3D Sci-Fi Three.js Scene Core */

let scene, camera, renderer;
let neuralCore, particleSystem;
let ringWhisper, ringOllama, ringSystem;
let targetCameraPos = { x: 0, y: 0, z: 12 };

function init3DScene() {
  const container = document.getElementById('webgl-canvas');
  if (!container) return;

  // The backdrop is decorative and three.js is loaded only if it is present
  // locally. This dashboard has to work on a machine with no internet access —
  // it is the control surface for a local-first app — so a missing library
  // must degrade to the CSS backdrop rather than throw and take the rest of
  // the page's onload handler (status polling, log streaming) down with it.
  if (typeof THREE === 'undefined') {
    container.classList.add('webgl-fallback');
    return;
  }

  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0B0C10, 0.035);

  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(targetCameraPos.x, targetCameraPos.y, targetCameraPos.z);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  // Ambient & Point Lighting
  const ambientLight = new THREE.AmbientLight(0x0B0C10, 2);
  scene.add(ambientLight);

  const tealLight = new THREE.PointLight(0x00FFC8, 3, 50);
  tealLight.position.set(0, 0, 5);
  scene.add(tealLight);

  const cobaltLight = new THREE.PointLight(0x0047FF, 2, 50);
  cobaltLight.position.set(-10, 10, -5);
  scene.add(cobaltLight);

  // 1. Central Low-Poly Neural Core
  const coreGeo = new THREE.IcosahedronGeometry(2.2, 1);
  const coreMat = new THREE.MeshBasicMaterial({
    color: 0x00FFC8,
    wireframe: true,
    transparent: true,
    opacity: 0.8
  });
  neuralCore = new THREE.Mesh(coreGeo, coreMat);
  scene.add(neuralCore);

  // 2. Concentric Status Rings
  const ringGeo = new THREE.TorusGeometry(3.6, 0.03, 16, 100);
  
  ringWhisper = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0x00FFC8 }));
  ringWhisper.rotation.x = Math.PI / 3;
  scene.add(ringWhisper);

  ringOllama = new THREE.Mesh(new THREE.TorusGeometry(4.4, 0.03, 16, 100), new THREE.MeshBasicMaterial({ color: 0x0047FF }));
  ringOllama.rotation.y = Math.PI / 4;
  scene.add(ringOllama);

  ringSystem = new THREE.Mesh(new THREE.TorusGeometry(5.2, 0.03, 16, 100), new THREE.MeshBasicMaterial({ color: 0xFFB800 }));
  ringSystem.rotation.x = -Math.PI / 4;
  scene.add(ringSystem);

  // 3. Background Particle Cloud (500 sparks)
  const particleCount = 500;
  const particleGeo = new THREE.BufferGeometry();
  const positions = new Float32Array(particleCount * 3);

  for (let i = 0; i < particleCount * 3; i += 3) {
    positions[i] = (Math.random() - 0.5) * 40;
    positions[i + 1] = (Math.random() - 0.5) * 40;
    positions[i + 2] = (Math.random() - 0.5) * 40;
  }

  particleGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const particleMat = new THREE.PointsMaterial({
    color: 0x00FFC8,
    size: 0.08,
    transparent: true,
    opacity: 0.6
  });
  particleSystem = new THREE.Points(particleGeo, particleMat);
  scene.add(particleSystem);

  window.addEventListener('resize', onWindowResize);
  animate();
}

function animate() {
  requestAnimationFrame(animate);

  const time = Date.now() * 0.001;

  if (neuralCore) {
    neuralCore.rotation.x += 0.004;
    neuralCore.rotation.y += 0.006;
    const scale = 1 + Math.sin(time * 2) * 0.05;
    neuralCore.scale.set(scale, scale, scale);
  }

  if (ringWhisper) ringWhisper.rotation.z += 0.008;
  if (ringOllama) ringOllama.rotation.z -= 0.006;
  if (ringSystem) ringSystem.rotation.z += 0.004;

  if (particleSystem) particleSystem.rotation.y += 0.0005;

  // Smooth lerp camera movement
  camera.position.x += (targetCameraPos.x - camera.position.x) * 0.05;
  camera.position.y += (targetCameraPos.y - camera.position.y) * 0.05;
  camera.position.z += (targetCameraPos.z - camera.position.z) * 0.05;

  renderer.render(scene, camera);
}

function setCameraTarget(x, y, z) {
  targetCameraPos = { x, y, z };
}

/**
 * Colours the three status rings from real service health, so the centrepiece
 * of the scene reflects the system instead of spinning at a fixed colour.
 */
function setRingStates(whisperOk, ollamaOk, systemOk) {
  const paint = (ring, ok, okColor) => {
    if (ring && ring.material) {
      ring.material.color.setHex(ok ? okColor : 0x4A4F57);
    }
  };

  paint(ringWhisper, whisperOk, 0x00FFC8);
  paint(ringOllama, ollamaOk, 0x0047FF);
  paint(ringSystem, systemOk, 0xFFB800);
}

function onWindowResize() {
  if (!camera || !renderer) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

window.init3DScene = init3DScene;
window.setCameraTarget = setCameraTarget;
window.setRingStates = setRingStates;
