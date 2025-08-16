import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { initializeApp } from "firebase/app";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
  signInWithCustomToken,
} from "firebase/auth";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
} from "firebase/firestore";

// --- GAME STATE VARIABLES ---
let scene, camera, renderer, raycaster, mouse, composer;
let notificationTimer = null;
let currentLevel = 1;
let N = 1;
let board = [];
let cubes = [];
let wireframes = [];
let queens = [];
let levelCompleted = false;
let unlockStatus = 'none'; // none, good_enough, perfect
let hoveredCube = null;
let isAssistMode = false; // State for hint mode, default off
let particles;
const isTouchDevice = 'ontouchstart' in window;

// --- HIGHLIGHT COLORS ---
const VALID_COLOR = new THREE.Color(0x2ecc71); // Green
const INVALID_COLOR = new THREE.Color(0xFFFFFF); // White for invalid wireframes
const CONFLICT_COLOR = new THREE.Color(0xdc143c); // Crimson for conflicting queens
const HOVER_COLOR = new THREE.Color(0x00ffff); // Cyan

// --- FIREBASE & USER DATA ---
let db, auth, userId;
let bestScores = {};
let lastSession = { level: 1, board: null };
const knownMaxQueens = [
  0, 1, 1, 4, 8, 12, 18, 24, 32, 42, 52, 64, 78, 94, 112, 132, 154,
];

// --- CAMERA & CONTROLS ---
let isDragging = false;
let dragStartPos = null;
let previousMousePosition = { x: 0, y: 0 };
let cameraDistance = 12;
let cameraAngleX = Math.PI / 6;
let cameraAngleY = Math.PI / 4;
let targetCameraAngleX = cameraAngleX;
let targetCameraAngleY = cameraAngleY;
let hiddenLayers = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
let pinchStartDistance = 0; // For touch zoom

// --- INITIALIZATION ---
function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  camera = new THREE.PerspectiveCamera(
    50,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );

  const canvas = document.getElementById("canvas");
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ReinhardToneMapping;

  const ambientLight = new THREE.AmbientLight(0xcccccc, 0.8);
  scene.add(ambientLight);
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.6);
  directionalLight.position.set(10, 15, 5);
  directionalLight.castShadow = true;
  scene.add(directionalLight);

  const renderScene = new RenderPass(scene, camera);
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    1.5,
    0.4,
    0.85
  );
  bloomPass.threshold = 0;
  bloomPass.strength = 0.5;
  bloomPass.radius = 0;
  
  const smaaPass = new SMAAPass( 
      window.innerWidth * renderer.getPixelRatio(), 
      window.innerHeight * renderer.getPixelRatio() 
  );

  composer = new EffectComposer(renderer);
  composer.addPass(renderScene);
  composer.addPass(smaaPass);
  composer.addPass(bloomPass);

  onWindowResize();

  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2();

  createParticles();
  setupEventListeners();
  initializeFirebase();
  animate();
}

async function initializeFirebase() {
  try {
    const firebaseConfig =
      typeof __firebase_config !== "undefined"
        ? JSON.parse(__firebase_config)
        : {
            apiKey: "invalid",
            authDomain: "invalid",
            projectId: "invalid",
          };

    const app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    auth = getAuth(app);

    let gameStarted = false;

    onAuthStateChanged(auth, async (user) => {
      if (user && !gameStarted) {
        gameStarted = true;
        userId = user.uid;
        await loadGameData();
        startLevel(1);
      }
    });

    if (
      typeof __initial_auth_token !== "undefined" &&
      __initial_auth_token
    ) {
      await signInWithCustomToken(auth, __initial_auth_token);
    } else {
      await signInAnonymously(auth);
    }
  } catch (error) {
    console.error(
      "Firebase initialization failed. Running in offline mode.",
      error
    );
    startLevel(1);
  }
}

// Helper function to add listeners reliably on mobile and desktop
function addButtonListener(element, handler) {
    if (!element) return;
    const eventName = isTouchDevice ? 'touchstart' : 'click';
    element.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
        handler(event);
    });
}

function setupEventListeners() {
  window.addEventListener("resize", onWindowResize);
  const canvas = document.getElementById("canvas");

  if (isTouchDevice) {
      canvas.addEventListener('touchstart', onTouchStart, { passive: false });
      canvas.addEventListener('touchmove', onTouchMove, { passive: false });
      canvas.addEventListener('touchend', onTouchEnd);
      document.querySelector('.mobile-controls').style.display = 'block';
      document.querySelector('.desktop-controls').style.display = 'none';
  } else {
      canvas.addEventListener("mousedown", onMouseDown);
      canvas.addEventListener("mousemove", onMouseMove);
      canvas.addEventListener("mouseup", onMouseUp);
      canvas.addEventListener("mouseleave", onMouseLeave);
      canvas.addEventListener("wheel", onMouseWheel);
      document.querySelector('.mobile-controls').style.display = 'none';
      document.querySelector('.desktop-controls').style.display = 'block';
  }
  document.addEventListener("keydown", onKeyDown);

  // Use the new helper for all buttons
  addButtonListener(document.getElementById("assistModeBtn"), () => {
      isAssistMode = !isAssistMode;
      document.getElementById("assistModeBtn").classList.toggle("active", isAssistMode);
      updateDisplay();
  });

  addButtonListener(document.querySelector(".layer-controls .up"), () => changeRelativeLayer("up"));
  addButtonListener(document.querySelector(".layer-controls .down"), () => changeRelativeLayer("down"));
  addButtonListener(document.querySelector(".layer-controls .left"), () => changeRelativeLayer("left"));
  addButtonListener(document.querySelector(".layer-controls .right"), () => changeRelativeLayer("right"));
  addButtonListener(document.querySelector(".layer-controls .reset"), () => changeLayer("reset"));

  addButtonListener(document.getElementById("nextLevelBtn"), nextLevel);
  addButtonListener(document.getElementById("resetBtn"), resetLevel);
  addButtonListener(document.getElementById("restoreSessionBtn"), restoreLastSession);
  
  addButtonListener(document.getElementById("prevLevelBtn"), () => navigateLevel(-1));
  addButtonListener(document.getElementById("nextLevelNavBtn"), () => navigateLevel(1));
  addButtonListener(document.getElementById("dPadToggleBtn"), () => {
    document.querySelector(".layer-controls").classList.toggle("visible");
  });
  
  document.getElementById("levelInput").addEventListener("change", (e) => {
    const level = parseInt(e.target.value);
    if (level > 0) startLevel(level);
  });
}

// --- EVENT HANDLERS & CONTROLS ---
function onKeyDown(event) {
  if (event.target.tagName === "INPUT") return;

  switch (event.code) {
    case "ArrowUp":
      changeRelativeLayer("up");
      break;
    case "ArrowDown":
      changeRelativeLayer("down");
      break;
    case "ArrowLeft":
      changeRelativeLayer("left");
      break;
    case "ArrowRight":
      changeRelativeLayer("right");
      break;
    case "KeyR":
      changeLayer("reset");
      break;
    default:
      return;
  }
  event.preventDefault();
}

function onMouseDown(event) {
  if (event.target.id !== "canvas") return;
  isDragging = false;
  dragStartPos = { x: event.clientX, y: event.clientY, time: Date.now() };
  previousMousePosition = { x: event.clientX, y: event.clientY };
  document.getElementById("canvas").classList.add("dragging");
}

function onMouseMove(event) {
  if (!dragStartPos) {
    if (!isTouchDevice) updateHoverEffect(event);
    return;
  }
  const deltaSq =
    (event.clientX - dragStartPos.x) ** 2 +
    (event.clientY - dragStartPos.y) ** 2;
  if (deltaSq > 16) isDragging = true;

  if (isDragging) {
    const deltaX = event.clientX - previousMousePosition.x;
    const deltaY = event.clientY - previousMousePosition.y;
    targetCameraAngleY -= deltaX * 0.008;
    targetCameraAngleX += deltaY * 0.008;
    targetCameraAngleX = Math.max(
      -Math.PI / 2,
      Math.min(Math.PI / 2, targetCameraAngleX)
    );
    previousMousePosition = { x: event.clientX, y: event.clientY };
  }
}

function onMouseUp(event) {
  if (dragStartPos && !isDragging && event.target.id === "canvas") {
    handleCanvasClick(event);
  }
  dragStartPos = null;
  isDragging = false;
  document.getElementById("canvas").classList.remove("dragging");
}

function onTouchStart(event) {
    if (event.target.id === 'canvas') {
        event.preventDefault();
    }
    
    if (event.touches.length === 1) {
        const touch = event.touches[0];
        isDragging = false;
        dragStartPos = { x: touch.clientX, y: touch.clientY, time: Date.now() };
        previousMousePosition = { x: touch.clientX, y: touch.clientY };
    } else if (event.touches.length === 2) {
        dragStartPos = null;
        const dx = event.touches[0].clientX - event.touches[1].clientX;
        const dy = event.touches[0].clientY - event.touches[1].clientY;
        pinchStartDistance = Math.sqrt(dx * dx + dy * dy);
    }
    document.getElementById("canvas").classList.add("dragging");
}

function onTouchMove(event) {
    if (event.target.id === 'canvas') {
        event.preventDefault();
    }

    if (event.touches.length === 1 && dragStartPos) {
        const touch = event.touches[0];
        const deltaSq = (touch.clientX - dragStartPos.x) ** 2 + (touch.clientY - dragStartPos.y) ** 2;
        if (deltaSq > 100) isDragging = true;

        if (isDragging) {
            const deltaX = touch.clientX - previousMousePosition.x;
            const deltaY = touch.clientY - previousMousePosition.y;
            targetCameraAngleY -= deltaX * 0.008;
            targetCameraAngleX += deltaY * 0.008;
            targetCameraAngleX = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, targetCameraAngleX));
            previousMousePosition = { x: touch.clientX, y: touch.clientY };
        }
    } else if (event.touches.length === 2) {
        isDragging = true;
        const dx = event.touches[0].clientX - event.touches[1].clientX;
        const dy = event.touches[0].clientY - event.touches[1].clientY;
        const pinchEndDistance = Math.sqrt(dx * dx + dy * dy);
        const deltaDistance = pinchStartDistance - pinchEndDistance;
        
        cameraDistance += deltaDistance * 0.05;
        cameraDistance = Math.max(N + 2, Math.min(40, cameraDistance));
        updateCameraPosition();
        
        pinchStartDistance = pinchEndDistance;
    }
}

function onTouchEnd(event) {
    if (dragStartPos && !isDragging) {
        const timeElapsed = Date.now() - dragStartPos.time;
        if (timeElapsed < 300) {
             handleCanvasClick(event.changedTouches[0]);
        }
    }
    dragStartPos = null;
    isDragging = false;
    document.getElementById("canvas").classList.remove("dragging");
}

function onMouseLeave() {
  if (hoveredCube) {
    setWireframeHighlight(hoveredCube, false);
    hoveredCube = null;
  }
}

function handleCanvasClick(event) {
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(
    cubes.filter((c) => c.visible)
  );
  if (intersects.length > 0) {
    const { x, y, z } = intersects[0].object.userData;
    toggleQueen(x, y, z);
  }
}

function updateHoverEffect(event) {
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(
    cubes.filter((c) => c.visible)
  );

  if (intersects.length > 0) {
    const intersectedObject = intersects[0].object;
    if (hoveredCube !== intersectedObject) {
      if (hoveredCube) {
        setWireframeHighlight(hoveredCube, false);
      }
      hoveredCube = intersectedObject;
      setWireframeHighlight(hoveredCube, true);
    }
  } else {
    if (hoveredCube) {
      setWireframeHighlight(hoveredCube, false);
      hoveredCube = null;
    }
  }
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
}

function onMouseWheel(event) {
  event.preventDefault();
  cameraDistance += event.deltaY * 0.01;
  cameraDistance = Math.max(N + 2, Math.min(40, cameraDistance));
  updateCameraPosition();
}

// --- LAYER CONTROLS ---
function getRelativeAxes() {
  const cameraDirection = new THREE.Vector3();
  camera.getWorldDirection(cameraDirection);
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3()
    .crossVectors(cameraDirection, up)
    .normalize();
  const trueUp = new THREE.Vector3()
    .crossVectors(right, cameraDirection)
    .normalize();
  const rightAxis = Math.abs(right.x) > Math.abs(right.z) ? "x" : "z";
  const upAxis = "y";
  return {
    right: {
      axis: rightAxis,
      prop: Math.sign(right[rightAxis]) > 0 ? "maxX" : "minX",
    },
    left: {
      axis: rightAxis,
      prop: Math.sign(right[rightAxis]) < 0 ? "maxX" : "minX",
    },
    up: {
      axis: upAxis,
      prop: Math.sign(trueUp[upAxis]) > 0 ? "maxY" : "minY",
    },
    down: {
      axis: upAxis,
      prop: Math.sign(trueUp[upAxis]) < 0 ? "maxY" : "minY",
    },
  };
}

function changeRelativeLayer(direction) {
  const axes = getRelativeAxes();
  const control = axes[direction];
  const oppositeControl =
    axes[{ up: "down", down: "up", left: "right", right: "left" }[direction]];
  if (hiddenLayers[oppositeControl.prop] > 0) {
    hiddenLayers[oppositeControl.prop]--;
  } else {
    hiddenLayers[control.prop]++;
  }
  changeLayer();
}

function changeLayer(axis) {
  if (axis === "reset") {
    hiddenLayers = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
  }
  const maxAllowed = N - 1;
  hiddenLayers.minX = Math.max(0, Math.min(hiddenLayers.minX, maxAllowed));
  hiddenLayers.maxX = Math.max(0, Math.min(hiddenLayers.maxX, maxAllowed));
  hiddenLayers.minY = Math.max(0, Math.min(hiddenLayers.minY, maxAllowed));
  hiddenLayers.maxY = Math.max(0, Math.min(hiddenLayers.maxY, maxAllowed));
  if (hiddenLayers.minX + hiddenLayers.maxX > maxAllowed) {
    hiddenLayers.minX + hiddenLayers.maxX - maxAllowed === 1
      ? hiddenLayers.maxX--
      : hiddenLayers.minX--;
  }
  if (hiddenLayers.minY + hiddenLayers.maxY > maxAllowed) {
    hiddenLayers.minY + hiddenLayers.maxY - maxAllowed === 1
      ? hiddenLayers.maxY--
      : hiddenLayers.minY--;
  }
  updateLayerVisibility();
}

function updateLayerVisibility() {
  cubes.forEach((cube) => {
    const { x, y, z } = cube.userData;
    const visible =
      x >= hiddenLayers.minX &&
      x < N - hiddenLayers.maxX &&
      y >= hiddenLayers.minY &&
      y < N - hiddenLayers.maxY &&
      z >= hiddenLayers.minZ &&
      z < N - hiddenLayers.maxZ;
    cube.visible = visible;
    const wireframe = findWireframeForCube(cube);
    if (wireframe) wireframe.visible = visible;
  });
  queens.forEach((queen) => {
    const { x, y, z } = queen.userData;
    const visible =
      x >= hiddenLayers.minX &&
      x < N - hiddenLayers.maxX &&
      y >= hiddenLayers.minY &&
      y < N - hiddenLayers.maxY &&
      z >= hiddenLayers.minZ &&
      z < N - hiddenLayers.maxZ;
    queen.visible = visible;
  });
  updateLayerInfo();
}

function updateLayerInfo() {
  document.getElementById("layerInfo").textContent = "";
}

// --- GAME LOGIC ---
function startLevel(level, initialBoard = null) {
  currentLevel = level;
  N = level;
  levelCompleted = false;
  unlockStatus = 'none';

  document.querySelector(".game-header").classList.add("is-active");
  document.querySelector(".controls-top-left").classList.add("is-active");
  document.querySelector(".controls-top-right").classList.remove("is-active");
  
  document.getElementById("levelInput").value = currentLevel;
  document.getElementById("levelTitle").textContent = `Level ${currentLevel}`;

  const target = getLevelTarget(N);
  document.getElementById("targetQueens").textContent = target;

  document.getElementById("personalBest").textContent = bestScores[N] || 0;

  document.getElementById("nextLevelBtn").disabled = true;

  if (initialBoard) {
    board = initialBoard;
  } else {
    initializeBoard();
  }
  createBoardGeometry();
  updateDisplay();
}

function resetLevel() {
  levelCompleted = false;
  unlockStatus = 'none';
  
  document.querySelector(".game-header").classList.add("is-active");
  document.querySelector(".controls-top-left").classList.add("is-active");
  document.querySelector(".controls-top-right").classList.remove("is-active");
  
  document.getElementById("nextLevelBtn").disabled = true;
  initializeBoard();
  updateDisplay();
}

function nextLevel() {
  if (!levelCompleted) return;
  startLevel(currentLevel + 1);
}

function navigateLevel(direction) {
  const newLevel = currentLevel + direction;
  if (newLevel > 0) {
    startLevel(newLevel);
  }
}

function initializeBoard() {
  board = Array.from({ length: N }, () =>
    Array.from({ length: N }, () => Array(N).fill(false))
  );
}

function toggleQueen(x, y, z) {
  board[z][y][x] = !board[z][y][x];
  updateDisplay();
  saveCurrentState();
}

function isQueenAttacking(x1, y1, z1, x2, y2, z2) {
  if (x1 === x2 && y1 === y2 && z1 === z2) return false;
  const dx = Math.abs(x1 - x2);
  const dy = Math.abs(y1 - y2);
  const dz = Math.abs(z1 - z2);
  if (
    (dx === 0 && dy === 0) ||
    (dx === 0 && dz === 0) ||
    (dy === 0 && dz === 0)
  )
    return true;
  if (
    (dx === 0 && dy === dz) ||
    (dy === 0 && dx === dz) ||
    (dz === 0 && dx === dy)
  )
    return true;
  if (dx === dy && dy === dz) return true;
  return false;
}

function getConflicts(queensList) {
  const conflictSet = new Set();
  for (let i = 0; i < queensList.length; i++) {
    for (let j = i + 1; j < queensList.length; j++) {
      const q1 = queensList[i];
      const q2 = queensList[j];
      if (
        isQueenAttacking(
          q1.userData.x,
          q1.userData.y,
          q1.userData.z,
          q2.userData.x,
          q2.userData.y,
          q2.userData.z
        )
      ) {
        conflictSet.add(q1);
        conflictSet.add(q2);
      }
    }
  }
  return { count: conflictSet.size, set: conflictSet };
}

function getLevelTarget(level) {
  if (level < knownMaxQueens.length) {
    return knownMaxQueens[level];
  }
  return Math.floor((level * level) / 2);
}

function restoreLastSession() {
  if (lastSession && lastSession.board) {
    startLevel(lastSession.level, JSON.parse(lastSession.board));
  }
}

// --- RENDERING & DISPLAY ---
function createBoardGeometry() {
  [...cubes, ...wireframes, ...queens].forEach((obj) => scene.remove(obj));
  cubes = [];
  wireframes = [];
  queens = [];

  const cubeGeometry = new THREE.BoxGeometry(0.95, 0.95, 0.95);
  const wireframeGeometry = new THREE.EdgesGeometry(cubeGeometry);
  const offset = (N - 1) / 2;

  for (let z = 0; z < N; z++)
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const solidMaterial = new THREE.MeshBasicMaterial({
          visible: false,
        });
        const solidCube = new THREE.Mesh(cubeGeometry, solidMaterial);
        solidCube.position.set(x - offset, y - offset, z - offset);
        solidCube.userData = { x, y, z };
        scene.add(solidCube);
        cubes.push(solidCube);

        const wireframeMaterial = new THREE.LineBasicMaterial({
          color: 0xaaaaaa,
          transparent: true,
          opacity: 0.5,
        });
        const wireframe = new THREE.LineSegments(
          wireframeGeometry,
          wireframeMaterial
        );
        wireframe.position.copy(solidCube.position);
        wireframe.userData = { x, y, z, baseColor: new THREE.Color(), baseOpacity: 0.5 };
        scene.add(wireframe);
        wireframes.push(wireframe);
      }

  hiddenLayers = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
  updateLayerVisibility();
  updateCameraPosition();
}

function updateDisplay() {
  const offset = (N - 1) / 2;

  queens.forEach((q) => scene.remove(q));
  queens = [];
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (board[z][y][x]) {
          const queenGeometry = new THREE.SphereGeometry(0.3, 16, 16);
          const queenMaterial = new THREE.MeshLambertMaterial({
            color: 0xdaa520,
          });
          const queen = new THREE.Mesh(queenGeometry, queenMaterial);
          queen.position.set(x - offset, y - offset, z - offset);
          queen.userData = { x, y, z };
          queen.castShadow = true;
          scene.add(queen);
          queens.push(queen);
        }
      }
    }
  }

  wireframes.forEach(wireframe => {
    const { x, y, z } = wireframe.userData;

    if (isAssistMode) {
        if (board[z][y][x]) {
            const distFromEdge = Math.min(x, N - 1 - x, y, N - 1 - y, z, N - 1 - z);
            wireframe.material.color.set(getWireframeDefaultColor(x, y, z));
            wireframe.material.opacity = Math.max(0.05, 0.8 - distFromEdge * 0.25);
        } else { 
            let isAttacked = false;
            if (queens.length > 0) {
                for (const queen of queens) {
                    if (isQueenAttacking(x, y, z, queen.userData.x, queen.userData.y, queen.userData.z)) {
                        isAttacked = true;
                        break;
                    }
                }
            }

            if (isAttacked) {
                wireframe.material.color.set(INVALID_COLOR);
                const distFromEdge = Math.min(x, N - 1 - x, y, N - 1 - y, z, N - 1 - z);
                wireframe.material.opacity = Math.max(0.05, 0.8 - distFromEdge * 0.25);
            } else {
                wireframe.material.color.set(VALID_COLOR);
                wireframe.material.opacity = 0.6;
            }
        }
    } else {
        const distFromEdge = Math.min(x, N - 1 - x, y, N - 1 - y, z, N - 1 - z);
        wireframe.material.color.set(getWireframeDefaultColor(x, y, z));
        wireframe.material.opacity = Math.max(0.05, 0.8 - distFromEdge * 0.25);
    }
    
    wireframe.userData.baseColor.copy(wireframe.material.color);
    wireframe.userData.baseOpacity = wireframe.material.opacity;
  });
  
  const { count: conflictCount, set: conflictSet } = getConflicts(queens);
  queens.forEach((queen) => {
    if (conflictSet.has(queen)) {
      queen.material.color.set(CONFLICT_COLOR);
    }
  });

  updateLayerVisibility();
  
  document.getElementById("queensCount").textContent = queens.length;
  
  const conflictContainer = document.getElementById("conflict-indicators");
  conflictContainer.innerHTML = "";
  for (let i = 0; i < conflictSet.size; i++) {
    const indicator = document.createElement("div");
    indicator.classList.add("conflict-indicator");
    indicator.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24" fill="currentColor"><path d="M12 2L2 22h20L12 2zm1 14h-2v-2h2v2zm0-4h-2V7h2v5z"/></svg>`;
    conflictContainer.appendChild(indicator);
  }

  if (conflictSet.size === 0 && queens.length > (bestScores[N] || 0)) {
    bestScores[N] = queens.length;
    document.getElementById("personalBest").textContent = bestScores[N];
    saveGameData();
  }

  const targetQueens = getLevelTarget(N);
  let newUnlockStatus = 'none';
  let message = "";

  if (conflictSet.size === 0) {
    if (queens.length >= targetQueens) {
      newUnlockStatus = 'perfect';
      message = queens.length > targetQueens 
        ? `New Record! ${queens.length} Queens!` 
        : `Perfect! Target Reached!`;
    }
  }

  if (newUnlockStatus !== 'none') {
    if (newUnlockStatus !== unlockStatus) {
      showSuccessMessage(message);
      unlockStatus = newUnlockStatus;
      document.querySelector(".controls-top-right").classList.add("is-active");
    }
    document.getElementById("nextLevelBtn").disabled = false;
    levelCompleted = true;
  } else {
    if (unlockStatus !== 'none') {
      document.querySelector(".controls-top-right").classList.remove("is-active");
    }
    document.getElementById("nextLevelBtn").disabled = true;
    levelCompleted = false;
    unlockStatus = 'none';
  }
}

// --- UTILITY & HELPER FUNCTIONS ---
function findWireframeForCube(solidCube) {
  const { x, y, z } = solidCube.userData;
  return wireframes.find(
    (w) => w.userData.x === x && w.userData.y === y && w.userData.z === z
  );
}

function getWireframeDefaultColor(x, y, z) {
  const distFromEdge = Math.min(x, N - 1 - x, y, N - 1 - y, z, N - 1 - z);
  return distFromEdge === 0 ? 0xf0f0f0 : 0xaaaaaa;
}

function setWireframeHighlight(cube, isHighlighted) {
  const wireframe = findWireframeForCube(cube);
  if (wireframe) {
    if (isHighlighted) {
      wireframe.material.color.set(HOVER_COLOR);
      wireframe.material.opacity = 1.0;
    } else {
      wireframe.material.color.copy(wireframe.userData.baseColor);
      wireframe.material.opacity = wireframe.userData.baseOpacity;
    }
  }
}

function showSuccessMessage(message) {
  const bar = document.getElementById("notification-bar");
  if (notificationTimer) {
    clearTimeout(notificationTimer);
  }
  bar.textContent = message;
  bar.classList.add("show");
  notificationTimer = setTimeout(() => {
    bar.classList.remove("show");
    notificationTimer = null;
  }, 3500);
}

function updateCameraPosition() {
  const x = cameraDistance * Math.sin(cameraAngleY) * Math.cos(cameraAngleX);
  const y = cameraDistance * Math.sin(cameraAngleX);
  const z = cameraDistance * Math.cos(cameraAngleY) * Math.cos(cameraAngleX);
  camera.position.set(x, y, z);
  camera.lookAt(0, 0, 0);
}

function animate() {
  requestAnimationFrame(animate);

  const dampingFactor = 0.2;
  cameraAngleX += (targetCameraAngleX - cameraAngleX) * dampingFactor;
  cameraAngleY += (targetCameraAngleY - cameraAngleY) * dampingFactor;
  updateCameraPosition();

  if (particles) {
    particles.rotation.y += 0.0002;
  }

  composer.render();
}

// --- FIREBASE FUNCTIONS ---
async function loadGameData() {
  if (!userId || !db) return;
  const appId =
    typeof __app_id !== "undefined" ? __app_id : "default-app-id";
  const docRef = doc(
    db,
    `artifacts/${appId}/users/${userId}/n_queens_save`,
    "gameState"
  );
  try {
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
      const data = docSnap.data();
      bestScores = data.scores || {};
      lastSession = data.lastSession || { level: 1, board: null };
    }
  } catch (e) {
    console.error("Error loading data:", e);
  }
}

async function saveGameData() {
  if (!userId || !db) return;
  const appId =
    typeof __app_id !== "undefined" ? __app_id : "default-app-id";
  const docRef = doc(
    db,
    `artifacts/${appId}/users/${userId}/n_queens_save`,
    "gameState"
  );
  try {
    await setDoc(docRef, { scores: bestScores, lastSession: lastSession });
  } catch (e) {
    console.error("Error saving data:", e);
  }
}

function saveCurrentState() {
  lastSession = {
    level: currentLevel,
    board: JSON.stringify(board),
  };
  saveGameData();
}

function createParticles() {
  const particleCount = 5000;
  const vertices = [];
  for (let i = 0; i < particleCount; i++) {
    const x = (Math.random() - 0.5) * 100;
    const y = (Math.random() - 0.5) * 100;
    const z = (Math.random() - 0.5) * 100;
    vertices.push(x, y, z);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(vertices, 3)
  );

  const material = new THREE.PointsMaterial({
    color: 0x888888,
    size: 0.15,
    transparent: true,
    opacity: 0.7,
  });

  particles = new THREE.Points(geometry, material);
  scene.add(particles);
}

document.getElementById("startGameBtn").addEventListener("click", () => {
  document.getElementById("startScreen").classList.add("hidden");
  document.querySelector(".ui-container").classList.add("active");
  init();
});