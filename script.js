const videoElement = document.getElementById('input_video');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');

const drawingCanvas = document.getElementById('drawing_canvas');
const drawingCtx = drawingCanvas.getContext('2d');

const gestureLabel = document.getElementById('gesture_label');
const actionLabel = document.getElementById('action_label');
const modeLabel = document.getElementById('mode_label');
const logContainer = document.getElementById('log_container');
const videoContainer = document.getElementById('video_container');

// Internal State
let drawingPoints = [];
let currentText = "";
let lastGestureTime = 0;
const GESTURE_COOLDOWN = 1500; // ms
const RECOGNIZE_COOLDOWN = 2000;

let isWriting = false;
let lastDrawPoint = null;
let lastDrawTime = 0;

let currentCommandGesture = "None";
let commandGestureStartTime = 0;
let commandExecuted = false;

let gestureSubmitTimeout = null;

// Ensure drawing canvas sizes match parent continuously
function resizeCanvas() {
    const rect = document.querySelector('.canvas-wrapper').getBoundingClientRect();
    drawingCanvas.width = rect.width;
    drawingCanvas.height = rect.height;
    
    const vRect = videoContainer.getBoundingClientRect();
    canvasElement.width = vRect.width;
    canvasElement.height = vRect.height;
}
window.addEventListener('resize', resizeCanvas);
setTimeout(resizeCanvas, 100);

// Setup MediaPipe Hands
const hands = new Hands({locateFile: (file) => {
  return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
}});

hands.setOptions({
  maxNumHands: 1,
  modelComplexity: 0, // 0 = fastest
  minDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5
});

hands.onResults(onResults);

const camera = new Camera(videoElement, {
  onFrame: async () => {
    await hands.send({image: videoElement});
  },
  width: 640,
  height: 480
});

camera.start();

function onResults(results) {
    if (canvasElement.width === 0) resizeCanvas();

    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    
    // Draw the camera image mirrored on the output_canvas
    canvasCtx.translate(canvasElement.width, 0);
    canvasCtx.scale(-1, 1);
    canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);
    
    // Darken it slightly to make hand mesh pop
    canvasCtx.fillStyle = "rgba(0,0,0,0.3)";
    canvasCtx.fillRect(0, 0, canvasElement.width, canvasElement.height);

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        const landmarks = results.multiHandLandmarks[0];
        
        // Let MediaPipe drawing utils draw the bones/nodes
        drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, {color: '#00ffff', lineWidth: 4});
        drawLandmarks(canvasCtx, landmarks, {color: '#b026ff', lineWidth: 2, radius: 4});
        
        processHandData(landmarks);
    } else {
        updateUI("None", "NONE", "IDLE");
        lastDrawPoint = null;
    }
    
    canvasCtx.restore();
}

function processHandData(landmarks) {
    const f = getThumbAndFingersExt(landmarks);
    const gesture = determineGesture(f, landmarks);
    
    let modeText = "IDLE";
    let actionText = "NONE";
    const now = Date.now();

    if (gesture !== currentCommandGesture) {
        currentCommandGesture = gesture;
        commandGestureStartTime = now;
        commandExecuted = false;
    }
    const holdTime = now - commandGestureStartTime;
    const HOLD_REQUIRED = 800; // Require 0.8s hold to prevent accidental triggers

    // Handling gestures mapping to text
    if (!commandExecuted && gesture === "Thumbs Up" && holdTime > HOLD_REQUIRED) {
        appendGestureWord("Yes");
        commandExecuted = true;
        lastGestureTime = now;
        actionText = "Added 'Yes'";
        flashBorder(videoContainer, '#10b981'); // Green pulse
    }
    else if (!commandExecuted && gesture === "Fist" && holdTime > HOLD_REQUIRED) {
        appendGestureWord("Help");
        commandExecuted = true;
        lastGestureTime = now;
        actionText = "Added 'Help'";
        flashBorder(videoContainer, '#ff265c'); // Red pulse
    }
    else if (!commandExecuted && gesture === "Open Palm" && holdTime > HOLD_REQUIRED) {
        appendGestureWord("Stop");
        commandExecuted = true;
        lastGestureTime = now;
        actionText = "Added 'Stop'";
        flashBorder(videoContainer, '#facc15'); // Yellow pulse
    }
    else if (!commandExecuted && gesture === "Horns" && holdTime > HOLD_REQUIRED) {
        appendGestureWord("Bad");
        commandExecuted = true;
        lastGestureTime = now;
        actionText = "Added 'Bad'";
        flashBorder(videoContainer, '#ef4444'); // Red pulse
    }
    else if (!commandExecuted && gesture === "Call" && holdTime > HOLD_REQUIRED) {
        appendGestureWord("Hello");
        commandExecuted = true;
        lastGestureTime = now;
        actionText = "Added 'Hello'";
        flashBorder(videoContainer, '#3b82f6'); // Blue pulse
    }
    
    // Writing Mode
    if (gesture === "Point") {
        modeText = "WRITING";
        actionText = "Recording...";
        
        let x = (1 - landmarks[8].x) * drawingCanvas.width;
        let y = landmarks[8].y * drawingCanvas.height;
        
        let dist = 0;
        if (lastDrawPoint) {
            dist = Math.hypot(x - lastDrawPoint.x, y - lastDrawPoint.y);
        }
        
        // Only consider the pen moving if it moves a few pixels
        if (!lastDrawPoint || dist > 3) {
            lastDrawTime = now;
        }
        
        drawStroke(x, y);
        
        // Auto-analyze instantly on pen lift (400ms gap) so user can write very fast
        if (drawingPoints.length > 5 && now - lastDrawTime > 400) {
            actionText = "Analyzing Letter...";
            recognizeAndClear();
            lastDrawTime = now;
        }
    } else {
        lastDrawPoint = null; // Lift pen to break the continuous line
        
        if (drawingPoints.length > 5 && now - lastDrawTime > 400 && gesture !== "RECOGNIZING") {
            actionText = "Analyzing Letter...";
            recognizeAndClear();
            lastDrawTime = now; // Reset so it doesn't repeatedly fire
        }
    }
    
    // Recognize Mode triggered by Peace Sign (manual override / submit word)
    if (!commandExecuted && gesture === "Peace" && holdTime > HOLD_REQUIRED) {
        modeText = "RECOGNIZING";
        if (drawingPoints.length > 5) {
            actionText = "Analyzing Canvas...";
            recognizeAndClear();
            commandExecuted = true;
            lastGestureTime = now;
            lastDrawTime = now;
        } else if (currentText.trim() !== "") {
            // Nothing to recognize? Submit the word to the Log instead!
            actionText = "Sent to Log";
            submitDraftToLog();
            commandExecuted = true;
            lastGestureTime = now;
        }
    }
    
    // New Gestures mappings
    if (!commandExecuted && gesture === "Space" && holdTime > HOLD_REQUIRED) {
        currentText += " "; // Add an actual space
        let textOutUI = document.getElementById('text_output');
        if (textOutUI) textOutUI.innerText = currentText;
        
        let draftUI = document.getElementById('live_draft');
        if (draftUI) draftUI.style.display = 'block';

        commandExecuted = true;
        lastGestureTime = now;
        actionText = "Added Space";
        flashBorder(videoContainer, '#38bdf8');
    }
    else if (!commandExecuted && gesture === "Backspace" && holdTime > HOLD_REQUIRED) {
        if (currentText.length > 0) {
            currentText = currentText.slice(0, -1);
            let textOutUI = document.getElementById('text_output');
            if (textOutUI) textOutUI.innerText = currentText;
            
            let draftUI = document.getElementById('live_draft');
            if (currentText.length === 0 && draftUI) draftUI.style.display = 'none';
        }
        commandExecuted = true;
        lastGestureTime = now;
        actionText = "Backspace";
        flashBorder(videoContainer, '#d946ef');
    }
    
    updateUI(gesture, actionText, modeText);
}

function getThumbAndFingersExt(landmarks) {
    function isExt(tip, pip, wrist) {
        const dTip = Math.hypot(landmarks[tip].x - landmarks[wrist].x, landmarks[tip].y - landmarks[wrist].y);
        const dPip = Math.hypot(landmarks[pip].x - landmarks[wrist].x, landmarks[pip].y - landmarks[wrist].y);
        return dTip > (dPip * 1.15); // Made more lenient for continuous line drawing
    }
    
    return {
        thumb: landmarks[4].y < landmarks[3].y - 0.05, 
        index: isExt(8, 6, 0),
        middle: isExt(12, 10, 0),
        ring: isExt(16, 14, 0),
        pinky: isExt(20, 18, 0)
    };
}

function determineGesture(f, landmarks) {
    let isThumbsUp = landmarks[4].y < landmarks[5].y && !f.index && !f.middle && !f.ring && !f.pinky;
    let isThumbsDown = landmarks[4].y > landmarks[3].y + 0.05 && !f.index && !f.middle && !f.ring && !f.pinky; // Thumb pointing down
    
    if (isThumbsUp) return "Thumbs Up";
    if (isThumbsDown) return "Backspace";
    
    // Pinky out (Space)
    if (!f.index && !f.middle && !f.ring && f.pinky && !f.thumb) return "Space";

    // Call Me (Thumb and pinky)
    if (!f.index && !f.middle && !f.ring && f.pinky && f.thumb) return "Call";

    // Horns (Index and pinky)
    if (f.index && !f.middle && !f.ring && f.pinky) return "Horns";

    // Fist: Only looking at the 4 main fingers folded. Thumb position varies too much for users.
    if (!f.index && !f.middle && !f.ring && !f.pinky) return "Fist";
    
    if (f.index && f.middle && f.ring && f.pinky) return "Open Palm";
    if (f.index && f.middle && !f.ring && !f.pinky) return "Peace";
    if (f.index && !f.middle && !f.ring && !f.pinky) return "Point";
    return "None";
}

function appendGestureWord(word) {
    if (currentText.length > 0 && !currentText.endsWith(' ')) {
        currentText += " " + word;
    } else {
        currentText += word;
    }
    
    let textOutUI = document.getElementById('text_output');
    if (textOutUI) textOutUI.innerText = currentText;
    
    let draftUI = document.getElementById('live_draft');
    if (draftUI) draftUI.style.display = 'block';
    
    // Automatically submit gesture words after 4s of inactivity
    if (gestureSubmitTimeout) clearTimeout(gestureSubmitTimeout);
    gestureSubmitTimeout = setTimeout(() => {
        if (currentText.trim() !== "") {
            submitDraftToLog();
        }
    }, 4000);
}

function updateUI(g, a, m) {
    gestureLabel.innerText = g;
    // Debounce resetting action immediately
    if (a !== "NONE") actionLabel.innerText = a;
    modeLabel.innerText = m;
    
    if (m === "WRITING") modeLabel.style.color = "#0ff";
    else if (m === "RECOGNIZING") modeLabel.style.color = "#10b981";
    else modeLabel.style.color = "#facc15";
}

function appendLogItem(text) {
    if (!logContainer) return;
    
    const div = document.createElement('div');
    div.style.display = 'flex';
    div.style.justifyContent = 'space-between';
    div.style.alignItems = 'center';
    div.style.background = 'rgba(0, 255, 255, 0.1)';
    div.style.border = '1px solid rgba(0, 255, 255, 0.3)';
    div.style.padding = '10px 15px';
    div.style.marginBottom = '10px';
    div.style.borderRadius = '8px';
    div.style.fontFamily = "'Orbitron', sans-serif";
    div.style.fontSize = '1.2rem';
    div.style.color = '#fff';
    
    const span = document.createElement('span');
    span.innerText = text;
    
    const speakBtn = document.createElement('button');
    speakBtn.innerText = '🔊 Speak';
    speakBtn.className = 'btn primary-btn';
    speakBtn.style.padding = '5px 10px';
    speakBtn.style.fontSize = '1rem';
    speakBtn.onclick = () => {
        let cleanText = text.replace(/[^a-zA-Z ]/g, "").trim();
        const utterance = new SpeechSynthesisUtterance(cleanText);
        speechSynthesis.speak(utterance);
    };
    
    const aiBtn = document.createElement('button');
    aiBtn.innerText = '🤖 AI Generate';
    aiBtn.className = 'btn';
    aiBtn.style.background = 'linear-gradient(45deg, #8b5cf6, #d946ef)';
    aiBtn.style.border = 'none';
    aiBtn.style.color = '#fff';
    aiBtn.style.padding = '5px 10px';
    aiBtn.style.fontSize = '1rem';
    aiBtn.style.marginLeft = '8px';
    aiBtn.onclick = () => generateAIOutputs(text);

    const btnGroup = document.createElement('div');
    btnGroup.style.display = 'flex';
    btnGroup.appendChild(speakBtn);
    btnGroup.appendChild(aiBtn);
    
    div.appendChild(span);
    div.appendChild(btnGroup);
    logContainer.appendChild(div);
    logContainer.scrollTop = logContainer.scrollHeight;
}

function flashBorder(el, color) {
    const oldBorderEdge = el.style.borderColor;
    const oldShadow = el.style.boxShadow;
    el.style.borderColor = color;
    el.style.boxShadow = `0 0 30px ${color}`;
    setTimeout(() => {
        el.style.borderColor = oldBorderEdge;
        el.style.boxShadow = oldShadow;
    }, 500);
}

// Drawing Logic for Virtual Canvas
function drawStroke(x, y) {
    drawingPoints.push({x, y});
    if (!lastDrawPoint) {
        lastDrawPoint = {x, y};
        return;
    }
    
    drawingCtx.beginPath();
    drawingCtx.moveTo(lastDrawPoint.x, lastDrawPoint.y);
    drawingCtx.lineTo(x, y);
    drawingCtx.strokeStyle = "#0ff"; // Cyan neon color
    drawingCtx.lineWidth = 10;
    drawingCtx.lineCap = "round";
    drawingCtx.lineJoin = "round";
    // Removed shadowBlur and shadowColor because drawing them every frame causes heavy lag on a lot of computers
    drawingCtx.stroke();
    
    lastDrawPoint = {x, y};
}

// System Buttons
document.getElementById('stop_system_btn').addEventListener('click', () => {
    if (camera) camera.stop();
    
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    drawingCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
    
    canvasCtx.fillStyle = "rgba(0, 0, 0, 0.9)";
    canvasCtx.fillRect(0, 0, canvasElement.width, canvasElement.height);

    updateUI("OFF", "SYSTEM STOPPED", "OFFLINE");
    
    const scanner = document.querySelector('.scanner-line');
    if (scanner) scanner.style.display = 'none';
    
    // Note: Since scaleX is -1 by default on output canvas, text must be drawn mirrored back.
    canvasCtx.save();
    canvasCtx.scale(-1, 1);
    canvasCtx.fillStyle = "#ff265c";
    canvasCtx.font = "30px 'Orbitron', Rajdhani, sans-serif";
    canvasCtx.textAlign = "center";
    canvasCtx.textBaseline = "middle";
    canvasCtx.fillText("SYSTEM OFFLINE", -canvasElement.width / 2, canvasElement.height / 2);
    canvasCtx.restore();
});

// Canvas Buttons
document.getElementById('clear_btn').addEventListener('click', () => {
    drawingCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
    drawingPoints = [];
    lastDrawPoint = null;
});

document.getElementById('recognize_btn').addEventListener('click', () => {
    if (drawingPoints.length > 0) {
        recognizeAndClear();
    } else if (currentText.trim() !== "") {
        submitDraftToLog();
    }
});

function submitDraftToLog() {
    let finalOutput = currentText.trim();
    if (!finalOutput) return;

    // Advanced Deaf-Sign Sentence Dictionary Macro
    const SENTENCE_DICTIONARY = {
        // Hello + Help
        "Hello Help": "Hello! Could you please come over here and help me?",
        "Help Hello": "Hello! Could you please come over here and help me?",
        
        // Stop + Bad
        "Stop Bad": "Please stop immediately, this is a dangerous situation.",
        "Bad Stop": "Please stop immediately, this is a dangerous situation.",
        
        // Yes + Help + Stop
        "Yes Help Stop": "Yes, I agree. We need to stop right now and get help.",
        "Stop Help Yes": "Yes, I agree. We need to stop right now and get help.",
        
        // Hello + Yes
        "Hello Yes": "Hello there! Yes, I completely understand and agree.",
        "Yes Hello": "Hello there! Yes, I completely understand and agree.",
        
        // Bad + Help
        "Bad Help": "Things are going very badly. I need immediate assistance!",
        "Help Bad": "Things are going very badly. I need immediate assistance!",
        
        // Stop + Yes
        "Stop Yes": "Yes, I agree that we should stop doing this right now.",
        "Yes Stop": "Yes, I agree that we should stop doing this right now.",
        
        // Hello + Bad
        "Hello Bad": "Hello! I am actually feeling really unwell today.",
        "Bad Hello": "Hello! I am actually feeling really unwell today.",
        
        // Yes + Bad
        "Yes Bad": "Yes, I have to agree that this is a bad idea.",
        "Bad Yes": "Yes, I have to agree that this is a bad idea.",
        
        // Stop + Help
        "Stop Help": "Please drop what you are doing and help me immediately.",
        "Help Stop": "Please drop what you are doing and help me immediately.",
        
        // Hello + Stop
        "Hello Stop": "Hello! Please stop right there for a moment.",
        "Stop Hello": "Hello! Please stop right there for a moment.",
        
        // Yes + Help
        "Yes Help": "Yes please! Any help you can give me would be great.",
        "Help Yes": "Yes please! Any help you can give me would be great.",
        
        // Bad + Bad
        "Bad Bad": "This is terrible! I repeat, this is very bad!"
    };

    // Normalize multiple spaces just in case
    let normalized = finalOutput.replace(/\s+/g, ' ');
    if (SENTENCE_DICTIONARY[normalized]) {
        finalOutput = SENTENCE_DICTIONARY[normalized];
    }
    
    // Clear auto-submit timeout whenever we manually submit
    if (gestureSubmitTimeout) clearTimeout(gestureSubmitTimeout);
    
    appendLogItem(finalOutput);
    currentText = "";
    let textOutUI = document.getElementById('text_output');
    if (textOutUI) textOutUI.innerText = "";
    
    let draftUI = document.getElementById('live_draft');
    if (draftUI) draftUI.style.display = 'none';
    
    // Never automatically clear the canvas—leave ink on screen until user explicitly clicks the 'Clear' button!
    // drawingCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
}

document.getElementById('clear_text_btn').addEventListener('click', () => {
    currentText = "";
    let textOutUI = document.getElementById('text_output');
    if (textOutUI) textOutUI.innerText = "";
    
    let draftUI = document.getElementById('live_draft');
    if (draftUI) draftUI.style.display = 'none';
    
    if (logContainer) {
        // remove all child divs except live_draft
        Array.from(logContainer.children).forEach(child => {
            if (child.id !== 'live_draft') {
                child.remove();
            }
        });
    }
});

// Speak all removed, using individual buttons now.

document.getElementById('close_ai_btn').addEventListener('click', () => {
    document.getElementById('ai_section').style.display = 'none';
});

function generateAIOutputs(text) {
    const aiSection = document.getElementById('ai_section');
    const container = document.getElementById('ai_results_container');
    
    aiSection.style.display = 'flex';
    container.innerHTML = '<div style="color: #0ff; text-align: center; padding: 20px; font-size: 1.2rem;">Generating expressive suggestions...</div>'; // Mock loading
    
    setTimeout(() => {
        container.innerHTML = '';
        
        let cleaned = text.trim();
        if(!cleaned) cleaned = "something";
        
        const suggestions = [
            { type: "Simple", format: `I want to say: ${cleaned}.` },
            { type: "Friendly", format: `Hey there! Just wanted to share: ${cleaned}. Hope you are having a great day!` },
            { type: "Emotional", format: `I feel so strongly about this: ${cleaned}! It really means a lot.` },
            { type: "Social Media", format: `Sharing my thoughts with everyone today: "${cleaned}" What do you guys think?` }
        ];
        
        suggestions.forEach(s => {
            const card = document.createElement('div');
            card.style.background = 'rgba(0, 255, 255, 0.05)';
            card.style.border = '1px solid rgba(0, 255, 255, 0.2)';
            card.style.borderRadius = '8px';
            card.style.padding = '15px';
            card.style.display = 'flex';
            card.style.justifyContent = 'space-between';
            card.style.alignItems = 'center';
            card.style.gap = '15px';
            
            const cont = document.createElement('div');
            
            const title = document.createElement('div');
            title.innerText = s.type;
            title.style.color = '#d946ef';
            title.style.fontSize = '0.9rem';
            title.style.fontFamily = "'Orbitron', sans-serif";
            title.style.marginBottom = '5px';
            title.style.fontWeight = 'bold';
            
            const msg = document.createElement('div');
            msg.innerText = s.format;
            msg.style.color = '#fff';
            msg.style.fontSize = '1.1rem';
            
            cont.appendChild(title);
            cont.appendChild(msg);
            
            const btn = document.createElement('button');
            btn.innerHTML = '🔊 Speak';
            btn.className = 'btn primary-btn';
            btn.style.whiteSpace = 'nowrap';
            btn.onclick = () => {
                const utterance = new SpeechSynthesisUtterance(s.format);
                speechSynthesis.speak(utterance);
            };
            
            card.appendChild(cont);
            card.appendChild(btn);
            
            container.appendChild(card);
        });
    }, 800);
}

function recognizeAndClear() {
    let letter = recognizeStrokeRuleBased(drawingPoints);
    if (letter && letter !== '?') {
        currentText += letter; // do not add gap so they form a single word
        
        let draftUI = document.getElementById('live_draft');
        if (draftUI) draftUI.style.display = 'block';
        
        let textOutUI = document.getElementById('text_output');
        if (textOutUI) textOutUI.innerText = currentText;
        
        const dw = document.querySelector('.drawing-module');
        flashBorder(dw, '#10b981'); // flash green
    } else {
        actionLabel.innerText = "COULD NOT READ";
        const dw = document.querySelector('.drawing-module');
        flashBorder(dw, '#ff265c'); // flash red
    }
    
    // Do NOT clear canvas so old letters remain on screen
    // drawingCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
    drawingPoints = [];
    lastDrawPoint = null;
}

// Heuristics Engine for Air-Written Strokes
// Supports single stroke: H, E, L, O, P
function recognizeStrokeRuleBased(points) {
    if (points.length < 5) return null;

    let minX = Math.min(...points.map(p => p.x));
    let maxX = Math.max(...points.map(p => p.x));
    let minY = Math.min(...points.map(p => p.y));
    let maxY = Math.max(...points.map(p => p.y));
    let w = maxX - minX;
    let h = maxY - minY;

    if (w < 20 && h < 20) return null; // Stroke is just a dot
    
    let dirs = [];
    let step = Math.max(2, Math.floor(points.length / 12));

    for (let i = 0; i < points.length - step; i += step) {
        let dx = points[i + step].x - points[i].x;
        let dy = points[i + step].y - points[i].y;

        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) continue;
        
        // 4 directions: U, D, L, R
        let dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'R' : 'L') : (dy > 0 ? 'D' : 'U');
        if (dirs.length === 0 || dirs[dirs.length - 1] !== dir) {
            dirs.push(dir);
        }
    }
    
    let seq = dirs.join('');
    console.log("AirStroke Signature:", seq);
    
    let startP = points[0];
    let endP = points[points.length - 1];
    let dist = Math.hypot(endP.x - startP.x, endP.y - startP.y);
    let diag = Math.hypot(w, h);

    // Letter 'O' (Circular, start & end close)
    if (dist < diag * 0.4 && seq.length >= 3 && w > 30 && h > 30) {
        return 'O';
    }
    
    // Letter 'P' (Up/Down, Right, Down, Left forming loop at top)
    if ((seq.includes('URD') || seq.includes('RDL')) && endP.y < maxY - h*0.2) {
        return 'P';
    }

    // Letter 'H' (Down, Up, Right, Down) or variants
    if (seq.includes('DURD') || seq.includes('DRD') || seq.includes('URDUR')) {
        return 'H';
    }

    // Letter 'E' (Zig-zag left-right mostly starting left)
    const countL = (seq.match(/L/g) || []).length;
    if (seq.startsWith('L') && countL >= 2) {
        return 'E';
    }
    if (seq.includes('LDR') || seq.includes('LUR') || seq.includes('LDL')) {
        // Fallback checks for C / E
        return 'E';
    }
    
    // Letter 'L' (Down then Right)
    // Often recorded strictly as DR or D R (with minor noise)
    if ((seq.startsWith('D') && seq.endsWith('R')) || seq.includes('DR') || seq === 'D' || (seq.startsWith('D') && w > 40 && endP.x > startP.x)) {
        // A simple L might have a large bounding box with start=top-left, middle=bottom-left, end=bottom-right
        if (w > h * 0.4 && startP.y < minY + h*0.3) {
            return 'L';
        }
    }

    // Letter 'M' (Up, down, up, down)
    if (seq.includes('UDUD') || seq.includes('DUDUD')) {
        return 'M';
    }

    // Letter 'W' (Down, up, down, up)
    if (seq.includes('DUDU')) {
        return 'W';
    }

    // Letter 'N' (Up, down, up)
    if (seq.includes('UDU') || seq.includes('URDRU')) {
        return 'N';
    }

    // Letter 'S' (Left, down, right, down, left)
    if (seq.includes('LDRDL') || (seq.startsWith('L') && seq.includes('R') && seq.endsWith('L') && h > 30)) {
        return 'S';
    }

    // Letter 'Z' (Right, down/left, right)
    if (seq.startsWith('R') && seq.endsWith('R') && (seq.includes('L') || seq.includes('D')) && seq.length <= 5) {
        return 'Z';
    }

    // Letter 'U' (Down, right, up)
    if (seq.includes('DRU') || seq.includes('DLU') || (seq.startsWith('D') && seq.endsWith('U') && w > 20)) {
        return 'U';
    }

    // Letter 'V' (Down, up)
    if (seq === 'DU' || seq === 'DRU' || seq === 'DLU') {
        if (h > w) return 'V';
    }

    // Heuristics Fallbacks
    if (h > w * 1.5 && dist > diag * 0.8) return 'I';
    
    return '?';
}
