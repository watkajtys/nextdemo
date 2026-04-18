import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

async function listModels() {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
    try {
        // Note: The @google/genai SDK might have different methods for listing models
        // depending on the version. If listModels() is not available, we'll try a different approach.
        // For now, let's try a common pattern.
        console.log("Attempting to list models...");
        // If the SDK doesn't support listModels directly, we might need to use the REST API
        // But let's try a simple generation test with the name the user mentioned first.
        
        const modelsToTest = [
            'gemini-3.1-flash-image-preview',
            'gemini-3-flash-image',
            'gemini-3-flash-image-preview',
            'gemini-3.5-flash-image-preview'
        ];

        for (const model of modelsToTest) {
            try {
                console.log(`Testing model: ${model}`);
                await ai.models.generateContent({
                    model: model,
                    contents: [{ text: "ping" }]
                });
                console.log(`✅ Model ${model} is AVAILABLE`);
            } catch (e) {
                console.log(`❌ Model ${model} is NOT available or failed: ${(e as Error).message}`);
            }
        }

    } catch (e) {
        console.error("Listing failed:", (e as Error).message);
    }
}
listModels();
