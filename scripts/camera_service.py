import io
import time
import threading
from flask import Flask, Response, send_file
from picamera2 import Picamera2

app = Flask(__name__)
picam2 = Picamera2()

try:
    # Configure for a 1080x1080 square to match our physical prints perfectly
    config = picam2.create_preview_configuration(main={"size": (1080, 1080)})
    picam2.configure(config)
    picam2.start()
    print("✅ Picamera2 started successfully.")
except Exception as e:
    print(f"❌ Error starting camera: {e}")

camera_lock = threading.Lock()

def generate_frames():
    while True:
        frame = None
        with camera_lock:
            try:
                stream = io.BytesIO()
                # Fast capture from the main stream
                picam2.capture_file(stream, format='jpeg')
                frame = stream.getvalue()
            except Exception as e:
                print(f"Preview error: {e}")
        
        if frame:
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + frame + b'\r\n')
        
        # Limit framerate to reduce CPU load (approx 15-20 fps)
        time.sleep(0.05)

@app.route('/preview')
def preview():
    return Response(generate_frames(), mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route('/capture', methods=['POST'])
def capture():
    stream = io.BytesIO()
    with camera_lock:
        try:
            # Synchronous native capture guarantees zero-shutter-lag
            picam2.capture_file(stream, format='jpeg')
        except Exception as e:
            return f"Capture error: {e}", 500
    
    stream.seek(0)
    return send_file(stream, mimetype='image/jpeg')

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, threaded=True)
