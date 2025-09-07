// Detect mobile device
function isMobile() {
    return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

// Request fullscreen
function goFullscreen() {
    const element = document.documentElement; // fullscreen the whole page
    
    if (element.requestFullscreen) {
        element.requestFullscreen();
    } else if (element.webkitRequestFullscreen) { // Safari
        element.webkitRequestFullscreen();
    } else if (element.msRequestFullscreen) { // IE/Edge
        element.msRequestFullscreen();
    }
}

// Run check and trigger fullscreen
window.addEventListener('load', () => {
    if (isMobile()) {
        // Many browsers only allow fullscreen on user interaction (like a tap),
        // so it's safer to bind it to a user event:
        document.body.addEventListener('click', () => {
            goFullscreen();
        }, { once: true });
    }
});