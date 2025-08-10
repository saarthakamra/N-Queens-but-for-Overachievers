import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously, onAuthStateChanged, signInWithCustomToken } from "firebase/auth";
import { getFirestore, doc, getDoc, setDoc } from "firebase/firestore";

// --- GAME STATE VARIABLES ---
let scene, camera, renderer, raycaster, mouse, composer;
let currentLevel = 1;
let N = 1; 
let board = [];
let cubes = [];
let wireframes = [];
let queens = [];
let maxQueensFound = 0;
let levelCompleted = false;
let hoveredCube = null;
let isCreativeMode = false;

// --- FIREBASE & USER DATA ---
let db, auth, userId;
let bestScores = {};
const knownMaxQueens = [0, 1, 1, 4, 8, 12, 18, 24, 32, 42, 52, 64, 78, 94, 112, 132, 154];

// --- CAMERA & CONTROLS ---
let isDragging = false;
let dragStartPos = null;
let previousMousePosition = { x: 0, y: 0 };
let cameraDistance = 12;
let cameraAngleX = Math.PI / 6;
let cameraAngleY = Math.PI / 4;
let hiddenLayers = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };

// --- INITIALIZATION ---
function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);

    camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
    
    const canvas = document.getElementById('canvas');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
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
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.5, 0.4, 0.85);
    bloomPass.threshold = 0;
    bloomPass.strength = 0.5;
    bloomPass.radius = 0;
    composer = new EffectComposer(renderer);
    composer.addPass(renderScene);
    composer.addPass(bloomPass);
    
    onWindowResize();

    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();

    setupEventListeners();
    initializeFirebase();
    animate();
}

async function initializeFirebase() {
    try {
        const firebaseConfig = typeof __firebase_config !== 'undefined' 
            ? JSON.parse(__firebase_config)
            : { apiKey: "invalid", authDomain: "invalid", projectId: "invalid" };
        
        const app = initializeApp(firebaseConfig);
        db = getFirestore(app);
        auth = getAuth(app);

        let gameStarted = false;

        onAuthStateChanged(auth, async (user) => {
            if (user && !gameStarted) {
                gameStarted = true;
                userId = user.uid;
                await loadBestScores();
                startLevel(1);
            }
        });

        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
            await signInWithCustomToken(auth, __initial_auth_token);
        } else {
            await signInAnonymously(auth);
        }

    } catch (error) {
        console.error("Firebase initialization failed. Running in offline mode.", error);
        startLevel(1);
    }
}

function setupEventListeners() {
    window.addEventListener('resize', onWindowResize);
    const canvas = document.getElementById('canvas');
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('mouseleave', onMouseLeave);
    canvas.addEventListener('wheel', onMouseWheel);
    document.addEventListener('keydown', onKeyDown);

    document.querySelector('.layer-controls .up').addEventListener('click', () => changeRelativeLayer('up'));
    document.querySelector('.layer-controls .down').addEventListener('click', () => changeRelativeLayer('down'));
    document.querySelector('.layer-controls .left').addEventListener('click', () => changeRelativeLayer('left'));
    document.querySelector('.layer-controls .right').addEventListener('click', () => changeRelativeLayer('right'));
    document.querySelector('.layer-controls .reset').addEventListener('click', () => changeLayer('reset'));

    document.getElementById('nextLevelBtn').addEventListener('click', nextLevel);
    document.getElementById('resetBtn').addEventListener('click', resetLevel);
    document.getElementById('creativeModeBtn').addEventListener('click', toggleCreativeMode);
    
    document.getElementById('prevLevelBtn').addEventListener('click', () => navigateLevel(-1));
    document.getElementById('nextLevelNavBtn').addEventListener('click', () => navigateLevel(1));
    document.getElementById('levelInput').addEventListener('change', (e) => {
        const level = parseInt(e.target.value);
        if (level > 0) startLevel(level);
    });
}

// --- EVENT HANDLERS & CONTROLS ---
function onKeyDown(event) {
    if (event.target.tagName === 'INPUT') return;

    switch(event.code) {
        case 'ArrowUp': changeRelativeLayer('up'); break;
        case 'ArrowDown': changeRelativeLayer('down'); break;
        case 'ArrowLeft': changeRelativeLayer('left'); break;
        case 'ArrowRight': changeRelativeLayer('right'); break;
        case 'KeyR': changeLayer('reset'); break;
        case 'KeyC': toggleCreativeMode(); break;
        default: return;
    }
    event.preventDefault();
}

function onMouseDown(event) {
    if (event.target.id !== 'canvas') return;
    isDragging = false;
    dragStartPos = { x: event.clientX, y: event.clientY };
    previousMousePosition = { x: event.clientX, y: event.clientY };
    document.getElementById('canvas').classList.add('dragging');
}

function onMouseMove(event) {
    if (!dragStartPos) {
        updateHoverEffect(event);
        return;
    };
    const deltaSq = (event.clientX - dragStartPos.x)**2 + (event.clientY - dragStartPos.y)**2;
    if (deltaSq > 16) isDragging = true;
    if (isDragging) {
        const deltaX = event.clientX - previousMousePosition.x;
        const deltaY = event.clientY - previousMousePosition.y;
        cameraAngleY -= deltaX * 0.008;
        cameraAngleX += deltaY * 0.008;
        cameraAngleX = Math.max(-Math.PI/2, Math.min(Math.PI/2, cameraAngleX));
        updateCameraPosition();
        previousMousePosition = { x: event.clientX, y: event.clientY };
    }
}

function onMouseUp(event) {
    if (dragStartPos && !isDragging && event.target.id === 'canvas') {
        handleCanvasClick(event);
    }
    dragStartPos = null;
    isDragging = false;
    document.getElementById('canvas').classList.remove('dragging');
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
    const intersects = raycaster.intersectObjects(cubes.filter(c => c.visible));
    if (intersects.length > 0) {
        const { x, y, z } = intersects[0].object.userData;
        toggleQueen(x, y, z);
    }
}

function updateHoverEffect(event) {
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(cubes.filter(c => c.visible));
    if (intersects.length > 0) {
        const intersectedObject = intersects[0].object;
        if (hoveredCube !== intersectedObject) {
            if (hoveredCube) setWireframeHighlight(hoveredCube, false);
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
    const right = new THREE.Vector3().crossVectors(cameraDirection, up).normalize();
    const trueUp = new THREE.Vector3().crossVectors(right, cameraDirection).normalize();
    const rightAxis = Math.abs(right.x) > Math.abs(right.z) ? 'x' : 'z';
    const upAxis = 'y';
    return {
        right: { axis: rightAxis, prop: Math.sign(right[rightAxis]) > 0 ? 'maxX' : 'minX' },
        left:  { axis: rightAxis, prop: Math.sign(right[rightAxis]) < 0 ? 'maxX' : 'minX' },
        up:    { axis: upAxis,    prop: Math.sign(trueUp[upAxis]) > 0 ? 'maxY' : 'minY' },
        down:  { axis: upAxis,    prop: Math.sign(trueUp[upAxis]) < 0 ? 'maxY' : 'minY' },
    };
}

function changeRelativeLayer(direction) {
    const axes = getRelativeAxes();
    const control = axes[direction];
    const oppositeControl = axes[{up: 'down', down: 'up', left: 'right', right: 'left'}[direction]];
    if (hiddenLayers[oppositeControl.prop] > 0) {
        hiddenLayers[oppositeControl.prop]--;
    } else {
        hiddenLayers[control.prop]++;
    }
    changeLayer();
}

function changeLayer(axis) {
    if (axis === 'reset') {
        hiddenLayers = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
    }
    const maxAllowed = N - 1;
    hiddenLayers.minX = Math.max(0, Math.min(hiddenLayers.minX, maxAllowed));
    hiddenLayers.maxX = Math.max(0, Math.min(hiddenLayers.maxX, maxAllowed));
    hiddenLayers.minY = Math.max(0, Math.min(hiddenLayers.minY, maxAllowed));
    hiddenLayers.maxY = Math.max(0, Math.min(hiddenLayers.maxY, maxAllowed));
    if (hiddenLayers.minX + hiddenLayers.maxX > maxAllowed) {
         hiddenLayers.minX + hiddenLayers.maxX - maxAllowed === 1 ? hiddenLayers.maxX-- : hiddenLayers.minX--;
    }
    if (hiddenLayers.minY + hiddenLayers.maxY > maxAllowed) {
         hiddenLayers.minY + hiddenLayers.maxY - maxAllowed === 1 ? hiddenLayers.maxY-- : hiddenLayers.minY--;
    }
    updateLayerVisibility();
}

function updateLayerVisibility() {
    cubes.forEach(cube => {
        const { x, y, z } = cube.userData;
        const visible = x >= hiddenLayers.minX && x < N - hiddenLayers.maxX &&
                        y >= hiddenLayers.minY && y < N - hiddenLayers.maxY &&
                        z >= hiddenLayers.minZ && z < N - hiddenLayers.maxZ;
        cube.visible = visible;
        const wireframe = findWireframeForCube(cube);
        if (wireframe) wireframe.visible = visible;
    });
    queens.forEach(queen => {
        const { x, y, z } = queen.userData;
        const visible = x >= hiddenLayers.minX && x < N - hiddenLayers.maxX &&
                        y >= hiddenLayers.minY && y < N - hiddenLayers.maxY &&
                        z >= hiddenLayers.minZ && z < N - hiddenLayers.maxZ;
        queen.visible = visible;
    });
    updateLayerInfo();
}

function updateLayerInfo() {
    const ranges = [];
    if (hiddenLayers.minX > 0 || hiddenLayers.maxX > 0) ranges.push(`X: ${hiddenLayers.minX}-${N - hiddenLayers.maxX - 1}`);
    if (hiddenLayers.minY > 0 || hiddenLayers.maxY > 0) ranges.push(`Y: ${hiddenLayers.minY}-${N - hiddenLayers.maxY - 1}`);
    if (hiddenLayers.minZ > 0 || hiddenLayers.maxZ > 0) ranges.push(`Z: ${hiddenLayers.minZ}-${N - hiddenLayers.maxZ - 1}`);
    document.getElementById('layerInfo').textContent = ranges.length > 0 ? ranges.join(', ') : 'All';
}

// --- GAME LOGIC ---
function startLevel(level) {
    currentLevel = level;
    N = level;
    levelCompleted = false;
    
    document.querySelectorAll('.ui-block').forEach(el => el.classList.remove('is-active'));
    document.getElementById('levelInput').value = currentLevel;
    document.getElementById('levelTitle').textContent = isCreativeMode ? `Creative Mode` : `Level ${currentLevel}`;
    document.getElementById('levelDescription').textContent = `${N}×${N}×${N} Board`;

    const target = getLevelTarget(N);
    document.getElementById('targetQueens').textContent = isCreativeMode ? '∞' : target;
    document.getElementById('personalBest').textContent = bestScores[N] || 0;
    
    document.getElementById('nextLevelBtn').disabled = true;
    
    initializeBoard();
    createBoardGeometry();
    updateDisplay();
}

function resetLevel() {
    levelCompleted = false;
    document.querySelectorAll('.ui-block').forEach(el => el.classList.remove('is-active'));
    document.getElementById('nextLevelBtn').disabled = true;
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

function toggleCreativeMode() {
    isCreativeMode = !isCreativeMode;
    const btn = document.getElementById('creativeModeBtn');
    btn.textContent = isCreativeMode ? 'Exit Creative [C]' : 'Creative Mode [C]';
    btn.classList.toggle('active', isCreativeMode);
    startLevel(currentLevel); // Reload the level with the new mode
}

function initializeBoard() {
    board = Array.from({ length: N }, () => Array.from({ length: N }, () => Array(N).fill(false)));
}

function toggleQueen(x, y, z) {
    board[z][y][x] = !board[z][y][x];
    updateDisplay();
}

function isQueenAttacking(x1, y1, z1, x2, y2, z2) {
    if (x1 === x2 && y1 === y2 && z1 === z2) return false;
    const dx = Math.abs(x1 - x2);
    const dy = Math.abs(y1 - y2);
    const dz = Math.abs(z1 - z2);
    if ((dx === 0 && dy === 0) || (dx === 0 && dz === 0) || (dy === 0 && dz === 0)) return true;
    if ((dx === 0 && dy === dz) || (dy === 0 && dx === dz) || (dz === 0 && dx === dy)) return true;
    if (dx === dy && dy === dz) return true;
    return false;
}

function getConflicts(queensList) {
    const conflictSet = new Set();
    for (let i = 0; i < queensList.length; i++) {
        for (let j = i + 1; j < queensList.length; j++) {
            const q1 = queensList[i];
            const q2 = queensList[j];
            if (isQueenAttacking(q1.userData.x, q1.userData.y, q1.userData.z, q2.userData.x, q2.userData.y, q2.userData.z)) {
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
    // Approximation for higher levels
    return Math.floor(level * level / 2);
}

// --- RENDERING & DISPLAY ---
function createBoardGeometry() {
    [...cubes, ...wireframes, ...queens].forEach(obj => scene.remove(obj));
    cubes = []; wireframes = []; queens = [];

    const cubeGeometry = new THREE.BoxGeometry(0.95, 0.95, 0.95);
    const wireframeGeometry = new THREE.EdgesGeometry(cubeGeometry);
    const offset = (N - 1) / 2;

    for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const solidMaterial = new THREE.MeshBasicMaterial({ visible: false });
        const solidCube = new THREE.Mesh(cubeGeometry, solidMaterial);
        solidCube.position.set(x - offset, y - offset, z - offset);
        solidCube.userData = { x, y, z };
        scene.add(solidCube);
        cubes.push(solidCube);

        const distFromEdge = Math.min(x, N - 1 - x, y, N - 1 - y, z, N - 1 - z);
        const opacity = Math.max(0.05, 0.8 - distFromEdge * 0.25);
        const color = distFromEdge === 0 ? 0xf0f0f0 : 0xaaaaaa;

        const wireframeMaterial = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
        const wireframe = new THREE.LineSegments(wireframeGeometry, wireframeMaterial);
        wireframe.position.copy(solidCube.position);
        wireframe.userData = { x, y, z };
        scene.add(wireframe);
        wireframes.push(wireframe);
    }
    
    hiddenLayers = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
    updateLayerVisibility();
    updateCameraPosition();
}

function updateDisplay() {
    const offset = (N - 1) / 2;
    
    queens.forEach(q => scene.remove(q));
    queens = [];

    for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        if (board[z][y][x]) {
            const queenGeometry = new THREE.SphereGeometry(0.3, 16, 16);
            const queenMaterial = new THREE.MeshLambertMaterial({ color: 0xdaa520 });
            const queen = new THREE.Mesh(queenGeometry, queenMaterial);
            queen.position.set(x - offset, y - offset, z - offset);
            queen.userData = { x, y, z };
            queen.castShadow = true;
            scene.add(queen);
            queens.push(queen);
        }
    }

    const { count: conflictCount, set: conflictSet } = getConflicts(queens);
    queens.forEach(queen => {
        if (conflictSet.has(queen)) queen.material.color.set(0xDC143C);
    });
    
    updateLayerVisibility();

    document.getElementById('queensCount').textContent = queens.length;
    document.getElementById('conflictsCount').textContent = conflictSet.size;
    
    if (isCreativeMode) return;

    // --- SCORE & LEVEL COMPLETION LOGIC ---
    if (conflictSet.size === 0 && queens.length > (bestScores[N] || 0)) {
        bestScores[N] = queens.length;
        document.getElementById('personalBest').textContent = bestScores[N];
        saveBestScores();
    }

    const targetQueens = getLevelTarget(N);
    if (conflictSet.size === 0 && queens.length >= targetQueens && !levelCompleted) {
        levelCompleted = true;
        document.getElementById('nextLevelBtn').disabled = false;
        document.querySelectorAll('.ui-block').forEach(el => el.classList.add('is-active'));
        const message = queens.length > targetQueens ? `New Record! You found ${queens.length}!` : `Perfect! Target reached!`;
        showSuccessMessage(message);
    } else if (levelCompleted && (conflictSet.size > 0 || queens.length < targetQueens)) {
        levelCompleted = false;
        document.getElementById('nextLevelBtn').disabled = true;
        document.querySelectorAll('.ui-block').forEach(el => el.classList.remove('is-active'));
    }
}

// --- UTILITY & HELPER FUNCTIONS ---
function findWireframeForCube(solidCube) {
    const { x, y, z } = solidCube.userData;
    return wireframes.find(w => w.userData.x === x && w.userData.y === y && w.userData.z === z);
}

function getWireframeDefaultColor(x, y, z) {
    const distFromEdge = Math.min(x, N - 1 - x, y, N - 1 - y, z, N - 1 - z);
    return distFromEdge === 0 ? 0xf0f0f0 : 0xaaaaaa;
}

function setWireframeHighlight(cube, isHighlighted) {
    const wireframe = findWireframeForCube(cube);
    if (wireframe) {
        if (isHighlighted) {
            wireframe.material.color.set(0x00ffff);
            wireframe.material.opacity = 1.0;
        } else {
            const distFromEdge = Math.min(cube.userData.x, N - 1 - cube.userData.x, cube.userData.y, N - 1 - cube.userData.y, cube.userData.z, N - 1 - cube.userData.z);
            wireframe.material.color.set(getWireframeDefaultColor(cube.userData.x, cube.userData.y, cube.userData.z));
            wireframe.material.opacity = Math.max(0.05, 0.8 - distFromEdge * 0.25);
        }
    }
}

function showSuccessMessage(message) {
    const bar = document.getElementById('notification-bar');
    bar.textContent = message;
    bar.classList.add('show');
    setTimeout(() => {
        bar.classList.remove('show');
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
    composer.render();
}

// --- FIREBASE FUNCTIONS ---
async function loadBestScores() {
    if (!userId || !db) return;
    const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
    const docRef = doc(db, `artifacts/${appId}/users/${userId}/scores`, "best");
    try {
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
            bestScores = docSnap.data().scores || {};
        }
    } catch (e) {
        console.error("Error loading scores:", e);
    }
}

async function saveBestScores() {
    if (!userId || !db) return;
    const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
    const docRef = doc(db, `artifacts/${appId}/users/${userId}/scores`, "best");
    try {
        await setDoc(docRef, { scores: bestScores });
    } catch (e) {
        console.error("Error saving scores:", e);
    }
}

document.getElementById('startGameBtn').addEventListener('click', () => {
    document.getElementById('startScreen').classList.add('hidden');
    document.querySelector('.ui-container').classList.add('active');
    init();
});
