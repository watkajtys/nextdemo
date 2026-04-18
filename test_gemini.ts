import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

async function test() {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
    try {
        const model = 'gemini-2.0-flash';
        console.log(`Testing model: ${model}`);
        const response = await ai.models.generateContent({
            model: model,
            contents: [{ text: "Hello, are you there?" }]
        });
        console.log("Success!");
        console.log(response.candidates?.[0]?.content?.parts?.[0]?.text);
    } catch (e) {
        console.error("Failed:", (e as Error).message);
    }
}
test();
