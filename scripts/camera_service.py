import os
import io
import time
import threading
from flask import Flask, Response, send_file
from picamera2 import Picamera2

app = Flask(__name__)
picam2 = Picamera2()

# Global variables to store the latest frame for the preview
last_frame = None
frame_lock = threading.Lock()
camera_operation_lock = threading.Lock()

def camera_worker():
    """
    Background thread that constantly pulls frames from the camera.
    This is MUCH more efficient than calling capture_file in a loop.
    """
    global last_frame
    consecutive_errors = 0
    
    while True:
        try:
            # capture_file(format='jpeg') on the main stream is fast if the camera is already running
            stream = io.BytesIO()
            with camera_operation_lock:
                picam2.capture_file(stream, format='jpeg')
            
            with frame_lock:
                last_frame = stream.getvalue()
            
            consecutive_errors = 0
        except Exception as e:
            print(f"Camera worker error: {e}")
            consecutive_errors += 1
            if consecutive_errors > 10:
                print("❌ Camera hardware failed. Forcing process exit to trigger kiosk auto-reboot.")
                os._exit(1)
        
        # Aim for ~20 FPS preview to keep CPU usage low
        time.sleep(0.05)

try:
    # Configure for a 1080x1080 square to match our physical prints
    config = picam2.create_preview_configuration(main={"size": (1080, 1080)})
    picam2.configure(config)
    picam2.start()
    print("✅ Picamera2 started successfully.")
    
    # Start the background frame grabber
    threading.Thread(target=camera_worker, daemon=True).start()
except Exception as e:
    print(f"❌ Error starting camera: {e}")

def generate_frames():
    """Yields the latest frame from the background worker."""
    while True:
        with frame_lock:
            frame = last_frame
        
        if frame:
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + frame + b'\r\n')
        
        time.sleep(0.06) # Match the worker's rate slightly slower

@app.route('/preview')
def preview():
    return Response(generate_frames(), mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route('/capture', methods=['POST'])
def capture():
    """
    Triggers a high-res capture. 
    By returning the last frame directly from memory, we avoid 
    hardware deadlocks and achieve true zero shutter lag.
    """
    try:
        with frame_lock:
            frame = last_frame
            
        if frame is None:
            return "Camera not ready", 500
            
        stream = io.BytesIO(frame)
        print("📸 Instant capture successful from memory buffer")
        return send_file(stream, mimetype='image/jpeg')
    except Exception as e:
        print(f"❌ Capture error: {e}")
        return f"Capture error: {e}", 500

if __name__ == '__main__':
    # Use threaded=True to allow multiple preview connections
    app.run(host='127.0.0.1', port=5000, threaded=True)
