import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import ffmpeg from "ffmpeg-static";

const inputPath = path.join(process.cwd(), "speech-output.wav");
const outputPath = path.join(process.cwd(), "speech-output.mp3");

console.log("Converting WAV to MP3...");

const ffmpegProcess = spawn(ffmpeg, [
  "-i", inputPath,
  "-q:a", "5",
  "-y",
  outputPath
]);

ffmpegProcess.on("close", (code) => {
  if (code === 0) {
    const stats = fs.statSync(outputPath);
    console.log(`Success! MP3 saved to ${outputPath}`);
    console.log(`File size: ${(stats.size / 1024).toFixed(2)} KB`);
    
    fs.unlinkSync(inputPath);
    console.log("Cleaned up temporary WAV file");
  } else {
    console.error(`FFmpeg error: exit code ${code}`);
    process.exit(1);
  }
});

ffmpegProcess.stderr.on("data", (data) => {
  process.stderr.write(data);
});
