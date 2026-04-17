import { GoogleGenAI } from '@google/genai';
import * as fs from 'fs';

async function main() {
  const ai = new GoogleGenAI({ apiKey: 'AIzaSyCh--jIrj84UEICdDVOW2sXpf5-mjbxBNY' });
  const imageData = fs.readFileSync('/Users/theair/WebstormProjects/nextdemo/test.jpg'); // We need a real photo
  const base64Image = imageData.toString('base64');
  
  const prompt = [
    { text: "Transform the person in the provided image into a high-contrast 1990s cyberpunk manga illustration. Keep the same pose and framing. Generate the image now." },
    {
      inlineData: {
        mimeType: "image/jpeg",
        data: base64Image,
      },
    },
  ];

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-image-preview",
      config: {
          responseModalities: ["IMAGE"],
      },
      contents: prompt,
    });
    
    for (const part of response.candidates[0].content.parts) {
      if (part.text) {
        console.log("TEXT:", part.text);
      } else if (part.inlineData) {
        const outData = part.inlineData.data;
        const buffer = Buffer.from(outData, "base64");
        fs.writeFileSync("output.png", buffer);
        console.log("IMAGE RECIEVED, length:", buffer.length);
      }
    }
  } catch (e) {
    console.error(e);
  }
}
main();
