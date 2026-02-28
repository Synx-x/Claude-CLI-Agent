import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { exec } from 'child_process';
import { promisify } from 'util';

dotenv.config();

const execAsync = promisify(exec);

const text = `South Africa adjusted tax brackets and medical credits for 2026 27, first time in 2 years. Tax brackets up 3.4 percent, entry threshold now 99 thousand rand instead of 95 thousand 750. Medical credits up about 12 rand per month for main beneficiaries. Treasury loses 13.7 billion in revenue. Only covers last year's inflation, accumulated bracket creep still not fully addressed.`;

async function generateWithWindowsTTS() {
  console.log('Generating speech using Windows TTS...');
  
  try {
    const outputPath = path.join(process.cwd(), 'speech-output.wav');
    
    // PowerShell script to use Windows TTS
    const psScript = `
Add-Type -AssemblyName System.Speech;
$speak = New-Object System.Speech.Synthesis.SpeechSynthesizer;
$speak.Rate = 0;
$speak.Volume = 100;
$speak.Speak("${text.replace(/"/g, '\\"')}");
$speak.SetOutputToWaveFile("${outputPath}");
$speak.Speak("${text.replace(/"/g, '\\"')}");
`;

    const tempPsFile = path.join(process.cwd(), 'tts-temp.ps1');
    fs.writeFileSync(tempPsFile, psScript);
    
    await execAsync(`powershell -ExecutionPolicy Bypass -File "${tempPsFile}"`);
    fs.unlinkSync(tempPsFile);
    
    console.log(`Success! Audio saved to ${outputPath}`);
    return outputPath;
  } catch (error) {
    console.error('Windows TTS error:', error.message);
    throw error;
  }
}

async function generateWithFreeAPI() {
  console.log('Generating speech using free TTS API...');
  
  try {
    // Using Google Translate TTS (free, no key required)
    const encodedText = encodeURIComponent(text);
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodedText}&tl=en&client=tw-ob`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      responseType: 'arraybuffer',
      timeout: 30000
    });

    const outputPath = path.join(process.cwd(), 'speech-output.mp3');
    fs.writeFileSync(outputPath, response.data);
    console.log(`Success! Audio saved to ${outputPath}`);
    return outputPath;
  } catch (error) {
    console.error('Free API error:', error.message);
    throw error;
  }
}

async function main() {
  try {
    let outputPath;
    
    // Try Windows TTS first (system-level, no API keys needed)
    try {
      outputPath = await generateWithWindowsTTS();
    } catch (err) {
      console.log('Windows TTS unavailable, trying free API...');
      outputPath = await generateWithFreeAPI();
    }

    const stats = fs.statSync(outputPath);
    console.log(`File size: ${(stats.size / 1024).toFixed(2)} KB`);
  } catch (error) {
    console.error('Failed to generate speech:', error.message);
    process.exit(1);
  }
}

main();
