# 📖 Story to Audiobook

A web application that transforms stories, novels, and other literary works into immersive audiobooks with character-specific voices.

## Features

✨ **Multi-Format Support**
- PDF
- EPUB
- DOCX
- TXT

🤖 **Intelligent Character Detection**
- Automatic identification of characters and narrators
- Natural Language Processing (NLP) analysis
- Character appearance tracking

🎵 **Voice Synthesis**
- Multiple voice options per character
- Character-specific voice selection
- Text-to-Speech (TTS) integration

📱 **Cross-Platform**
- Built with Vue 3 and Capacitor
- Works on web, iOS, and Android
- Responsive design

## Installation

### Prerequisites
- Node.js (14+)
- npm or yarn

### Setup

```bash
# Clone the repository
git clone https://github.com/L4U7Y97/story-to-audiobook.git
cd story-to-audiobook

# Install dependencies
npm install

# Start development server
npm run dev
```

## Building

### Web
```bash
npm run build
```

### iOS
```bash
npm run build
npm run cap:add:ios
npm run cap:open:ios
```

### Android
```bash
npm run build
npm run cap:add:android
npm run cap:open:android
```

## Architecture

### Components

1. **FileParser** (`src/services/FileParser.js`)
   - Handles multiple file formats
   - Converts documents to plain text

2. **StoryAnalyzer** (`src/services/StoryAnalyzer.js`)
   - NLP-based character identification
   - Extracts dialogue and narrative sections
   - Tracks character appearances

3. **AudiobookGenerator** (`src/services/AudiobookGenerator.js`)
   - Text-to-Speech synthesis
   - Audio chunk combination
   - Multi-voice support

4. **UI Components** (`src/App.vue`)
   - File upload interface
   - Character voice selection
   - Audio playback

## Tech Stack

- **Frontend**: Vue 3, Vite
- **Mobile**: Capacitor, Native iOS/Android
- **NLP**: Compromise.js
- **TTS Integration**: Ready for Google Cloud Text-to-Speech, AWS Polly, Azure Cognitive Services, or ElevenLabs
- **File Handling**: pdf-parse, epub, js-docx

## Future Enhancements

- [ ] Advanced character emotion detection
- [ ] Background music and sound effects
- [ ] Custom voice training
- [ ] Real-time preview
- [ ] Offline mode support
- [ ] Cloud storage integration
- [ ] Social sharing features
- [ ] Narrator customization

## API Integration

The app is ready to integrate with various TTS providers:

### Recommended Services

1. **Google Cloud Text-to-Speech** - Best quality
2. **ElevenLabs** - Natural sounding voices
3. **AWS Polly** - Scalable and reliable
4. **Azure Cognitive Services** - Enterprise support

## Configuration

Update `src/services/AudiobookGenerator.js` with your TTS API credentials:

```javascript
// Example with Google Cloud
const response = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    input: { text: sentence },
    voice: { languageCode: 'en-US', name: voiceCode },
    audioConfig: { audioEncoding: 'MP3' }
  })
})
```

## License

MIT License - See LICENSE file for details

## Contributing

Contributions are welcome! Please read CONTRIBUTING.md for details on our code of conduct and the process for submitting pull requests.

## Support

For issues and feature requests, please visit: https://github.com/L4U7Y97/story-to-audiobook/issues
