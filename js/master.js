/* Master/Host Logic */

/* State Machine */
const STATE = {
    WALL: 'WALL',
    QUESTION: 'QUESTION',
    REVEAL: 'REVEAL'
};

class MasterGame {
    constructor() {
        this.questions = [];
        this.currentQuestion = null;
        this.state = STATE.WALL;
        this.peerManager = new PeerManager(true); // Host mode
        this.selectedCategory = null;

        // DOM Elements
        this.elWall = document.querySelector('.category-wall');
        this.elQuestionOverlay = document.querySelector('.question-overlay');
        this.elRoomId = document.querySelector('.room-id');
        this.elQuestionText = document.querySelector('.question-text');
        this.elAnswers = {
            A: document.getElementById('ans-A'),
            B: document.getElementById('ans-B'),
            C: document.getElementById('ans-C')
        };
        this.elPlayerIndicator = document.querySelector('.player-indicator');

        this.loadQuestions();
        this.initNetwork();
        this.initControls();
    }

    async loadQuestions() {
        try {
            const response = await fetch('questions.json');
            this.questions = await response.json();
            this.renderWall();
        } catch (e) {
            console.error("Failed to load questions", e);
        }
    }

    initNetwork() {
        this.peerManager.onOpen((id) => {
            this.elRoomId.textContent = id;
        });

        this.peerManager.onData((data) => {
            this.handlePlayerInput(data);
        });

        // Initialize PeerJS
        this.peerManager.init();
    }

    handlePlayerInput(data) {
        if (data.type === 'LOGIN') {
            // Player joined
            this.elPlayerIndicator.classList.add('active');
            this.elPlayerIndicator.querySelector('span').textContent = 'P1 Connected';
        } else if (data.type === 'ANSWER') {
            if (this.state === STATE.QUESTION) {
                // Player selected an answer
                console.log('Player selected: ' + data.payload);
                this.elPlayerIndicator.classList.add('answered');
                this.playAudio('lock-in'); // Optional: Add sound later
            }
        }
    }

    renderWall() {
        this.elWall.innerHTML = '';
        this.questions.forEach((q, index) => {
            const card = document.createElement('div');
            card.className = 'category-cardglass-panel category-card';
            card.textContent = q.category;
            card.dataset.index = index;

            // If already played, mark as played (not implemented for full persist in this snippet) but check logic

            card.addEventListener('click', () => this.selectCategory(index));
            this.elWall.appendChild(card);
        });
    }

    selectCategory(index) {
        if (this.state !== STATE.WALL) return;

        this.selectedCategory = index;
        this.currentQuestion = this.questions[index];
        this.state = STATE.QUESTION;

        // Populate Question UI
        this.elQuestionText.textContent = this.currentQuestion.question;
        this.elAnswers.A.querySelector('.text').textContent = this.currentQuestion.options.A;
        this.elAnswers.B.querySelector('.text').textContent = this.currentQuestion.options.B;
        this.elAnswers.C.querySelector('.text').textContent = this.currentQuestion.options.C;

        // Reset styles
        Object.values(this.elAnswers).forEach(el => {
            el.className = 'answer-card glass-panel';
        });
        document.querySelector('.explanation-box').classList.add('hidden');

        // Show Overlay
        this.elQuestionOverlay.classList.remove('hidden');
        this.elQuestionOverlay.classList.add('animate-fade-in');

        // Notify Player
        this.peerManager.send({ type: 'STATE_CHANGE', payload: 'QUESTION' });
    }

    revealAnswer() {
        if (this.state !== STATE.QUESTION) return;
        this.state = STATE.REVEAL;

        const correct = this.currentQuestion.correct; // "A", "B", or "C"
        const correctEl = this.elAnswers[correct];

        // Highlight correct answer
        correctEl.classList.add('correct', 'reveal-highlight');

        // Show explanation
        const explBox = document.querySelector('.explanation-box');
        explBox.textContent = this.currentQuestion.explanation;
        explBox.classList.remove('hidden');
        explBox.classList.add('animate-scale-in');

        // Notify Player
        this.peerManager.send({ type: 'STATE_CHANGE', payload: 'REVEAL' });
    }

    closeQuestion() {
        // Mark category as played
        const card = this.elWall.children[this.selectedCategory];
        card.classList.add('played');

        // Hide overlay
        this.elQuestionOverlay.classList.add('hidden');
        this.state = STATE.WALL;

        // Reset player status for next round
        this.elPlayerIndicator.classList.remove('answered');

        // Notify Player
        this.peerManager.send({ type: 'STATE_CHANGE', payload: 'WALL' });
    }

    initControls() {
        // Keyboard shortcuts for Master
        document.addEventListener('keydown', (e) => {
            if (e.key === ' ') {
                if (this.state === STATE.QUESTION) {
                    this.revealAnswer();
                } else if (this.state === STATE.REVEAL) {
                    this.closeQuestion();
                }
            }
        });
    }

    // Placeholder playback
    playAudio(name) {
        // console.log('Playing audio: ' + name);
    }
}

// Start Game
document.addEventListener('DOMContentLoaded', () => {
    window.game = new MasterGame();
});
