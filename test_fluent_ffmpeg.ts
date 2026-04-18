import ffmpeg from 'fluent-ffmpeg';

async function test_fluent_ffmpeg() {
    console.log("Testing fluent-ffmpeg with inputOptions -f v4l2...");
    ffmpeg('/dev/video0')
        .inputOptions('-f v4l2')
        .inputOptions(['-input_format mjpeg', '-video_size 640x480'])
        .frames(1)
        .output('test_fluent_options_f.jpg')
        .on('start', (cmd) => console.log('Spawned:', cmd))
        .on('end', () => console.log("✅ inputOptions -f worked!"))
        .on('error', (err) => console.error("❌ inputOptions -f failed:", err.message))
        .run();
}

test_fluent_ffmpeg();
