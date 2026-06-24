<template>
  <div class="app-container" :class="{ 'dark-mode': darkMode }">
    <header class="app-header">
      <div class="header-content">
        <h1>📖 StA</h1>
        <button @click="darkMode = !darkMode" class="theme-toggle" :title="darkMode ? 'Light Mode' : 'Dark Mode'">
          {{ darkMode ? '☀️' : '🌙' }}
        </button>
      </div>
    </header>

    <main class="app-main">
      <div class="upload-section">
        <h2>Upload</h2>
        <div class="upload-area" @click="triggerFileInput" @dragover.prevent @drop.prevent="handleDrop">
          <input 
            ref="fileInput" 
            type="file" 
            @change="handleFileUpload" 
            accept=".pdf,.epub,.docx,.txt"
            hidden
          >
          <p>📄 Drag and drop your file or click to select</p>
          <p class="file-formats">Supported: PDF, EPUB, DOCX, TXT</p>
        </div>
        <div v-if="uploadedFile" class="file-info">
          <p>✓ File: {{ uploadedFile.name }}</p>
        </div>
      </div>

      <div v-if="uploadedFile" class="processing-section">
        <h2>Processing</h2>
        <button @click="analyzeStory" class="btn-primary">Analyze & Identify Characters</button>
        
        <div v-if="loading" class="loading">
          <p>🔄 Processing...</p>
        </div>

        <div v-if="characters.length > 0" class="characters-section">
          <h3>Characters Detected</h3>
          <div class="characters-list">
            <div v-for="char in characters" :key="char.id" class="character-card">
              <div class="character-header">
                <h4>{{ char.name }}</h4>
                <span class="character-type">{{ char.type }}</span>
              </div>
              <div class="voice-selector">
                <label>Voice:</label>
                <select v-model="char.voice">
                  <option value="male-young">Male - Young</option>
                  <option value="male-old">Male - Mature</option>
                  <option value="female-young">Female - Young</option>
                  <option value="female-old">Female - Mature</option>
                  <option value="neutral">Neutral</option>
                </select>
              </div>
              <p class="appearances">Appearances: {{ char.count }}</p>
            </div>
          </div>
        </div>
      </div>

      <div v-if="characters.length > 0" class="conversion-section">
        <h2>Generate Audiobook</h2>
        <button @click="generateAudiobook" class="btn-primary btn-generate">
          🎵 Generate Audiobook
        </button>
        
        <div v-if="audioGenerated" class="success-message">
          <p>✓ Audiobook generated successfully!</p>
          <audio :src="audioUrl" controls class="audio-player"></audio>
          <button @click="downloadAudio" class="btn-secondary">📥 Download Audio</button>
        </div>
      </div>
    </main>
  </div>
</template>

<script>
import { ref, watch, onMounted } from 'vue'
import StoryAnalyzer from './services/StoryAnalyzer.js'
import AudiobookGenerator from './services/AudiobookGenerator.js'
import FileParser from './services/FileParser.js'

export default {
  name: 'App',
  setup() {
    const fileInput = ref(null)
    const uploadedFile = ref(null)
    const characters = ref([])
    const loading = ref(false)
    const audioGenerated = ref(false)
    const audioUrl = ref(null)
    const storyText = ref({})
    const darkMode = ref(false)

    // Apply dark mode to document element
    watch(darkMode, (isDark) => {
      if (isDark) {
        document.documentElement.classList.add('dark-mode')
        document.body.style.background = '#1a1a1a'
        document.body.style.color = '#e0e0e0'
      } else {
        document.documentElement.classList.remove('dark-mode')
        document.body.style.background = '#ffffff'
        document.body.style.color = '#333'
      }
    })

    const triggerFileInput = () => {
      fileInput.value.click()
    }

    const handleFileUpload = async (event) => {
      console.log('handleFileUpload')
      await uploadStoryFile(event.target.files[0])
    }

    const handleDrop = async (event) => {
      await uploadStoryFile(event.dataTransfer.files[0])
    }

    const uploadStoryFile = async (file) => {
      console.log(file)
      if (file) {
        uploadedFile.value = file
        try {
          storyText.value = await FileParser.parse(file)
        } catch (error) {
          console.error('File parsing error:', error)
          alert('Error parsing file. Please try another.')
        }
      }
    }

    const analyzeStory = async () => {
      if (!storyText.value) return
      
      loading.value = true
      try {
        const analysis = await StoryAnalyzer.analyze(storyText.value)
        characters.value = analysis.characters
      } catch (error) {
        console.error('Analysis error:', error)
        alert('Error analyzing story')
      } finally {
        loading.value = false
      }
    }

    const generateAudiobook = async () => {
      if (!characters.value.length) return
      
      loading.value = true
      try {
        const characterVoices = characters.value.map(char => ({
          name: char.name,
          voice: char.voice
        }))
        
        audioUrl.value = await AudiobookGenerator.generate(
          storyText.value,
          characterVoices
        )
        audioGenerated.value = true
      } catch (error) {
        console.error('Audiobook generation error:', error)
        alert('Error generating audiobook')
      } finally {
        loading.value = false
      }
    }

    const downloadAudio = () => {
      if (audioUrl.value) {
        const a = document.createElement('a')
        a.href = audioUrl.value
        a.download = `${uploadedFile.value.name.split('.')[0]}-audiobook.mp3`
        a.click()
      }
    }

    return {
      fileInput,
      uploadedFile,
      characters,
      loading,
      audioGenerated,
      audioUrl,
      darkMode,
      triggerFileInput,
      handleFileUpload,
      handleDrop,
      analyzeStory,
      generateAudiobook,
      downloadAudio
    }
  }
}
</script>

<style scoped>
.app-container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 20px;
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  background: #ffffff;
  color: #333;
  transition: background-color 0.3s ease, color 0.3s ease;
  min-height: 100vh;
}

.app-container.dark-mode {
  background: #1a1a1a;
  color: #e0e0e0;
}

.app-header {
  text-align: center;
  margin-bottom: 40px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  padding: 40px 20px;
  border-radius: 10px;
  position: relative;
}

.header-content {
  display: flex;
  justify-content: center;
  align-items: center;
  position: relative;
}

.app-header h1 {
  font-size: 2.5em;
  margin: 0;
}

.theme-toggle {
  position: absolute;
  right: 20px;
  background: rgba(255, 255, 255, 0.2);
  border: 2px solid rgba(255, 255, 255, 0.5);
  color: white;
  font-size: 1.5em;
  width: 50px;
  height: 50px;
  border-radius: 50%;
  cursor: pointer;
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.theme-toggle:hover {
  background: rgba(255, 255, 255, 0.3);
  border-color: rgba(255, 255, 255, 0.8);
  transform: scale(1.1);
}

.app-header p {
  font-size: 1.1em;
  margin: 0;
  opacity: 0.9;
}

.app-main {
  display: grid;
  grid-template-columns: 1fr;
  gap: 30px;
}

.upload-section, .processing-section, .conversion-section {
  background: white;
  padding: 30px;
  border-radius: 10px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
  transition: background-color 0.3s ease, box-shadow 0.3s ease;
}

.dark-mode .upload-section,
.dark-mode .processing-section,
.dark-mode .conversion-section {
  background: #2a2a2a;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.5);
}

.upload-area {
  border: 2px dashed #667eea;
  border-radius: 8px;
  padding: 40px;
  text-align: center;
  cursor: pointer;
  transition: all 0.3s ease;
  background: #f8f9ff;
}

.dark-mode .upload-area {
  background: #1e1e1e;
  border-color: #764ba2;
}

.upload-area:hover {
  border-color: #764ba2;
  background: #f0f2ff;
}

.dark-mode .upload-area:hover {
  background: #252525;
  border-color: #667eea;
}

.file-formats {
  font-size: 0.9em;
  color: #666;
  margin-top: 10px;
}

.dark-mode .file-formats {
  color: #aaa;
}

.file-info {
  margin-top: 15px;
  padding: 10px;
  background: #e8f5e9;
  border-left: 4px solid #4caf50;
  border-radius: 4px;
}

.dark-mode .file-info {
  background: #1b5e20;
  border-left-color: #81c784;
  color: #c8e6c9;
}

.characters-section {
  margin-top: 30px;
}

.characters-section h3 {
  transition: color 0.3s ease;
}

.dark-mode .characters-section h3 {
  color: #e0e0e0;
}

.characters-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 20px;
  margin-top: 20px;
}

.character-card {
  background: linear-gradient(135deg, #667eea15 0%, #764ba215 100%);
  padding: 20px;
  border-radius: 8px;
  border: 1px solid #667eea30;
  transition: all 0.3s ease;
}

.dark-mode .character-card {
  background: linear-gradient(135deg, #667eea25 0%, #764ba225 100%);
  border: 1px solid #667eea40;
}

.character-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 15px;
}

.character-header h4 {
  margin: 0;
  color: #333;
  transition: color 0.3s ease;
}

.dark-mode .character-header h4 {
  color: #e0e0e0;
}

.character-type {
  background: #667eea;
  color: white;
  padding: 4px 10px;
  border-radius: 20px;
  font-size: 0.8em;
  font-weight: 600;
}

.voice-selector {
  margin: 15px 0;
}

.voice-selector label {
  display: block;
  font-weight: 600;
  margin-bottom: 8px;
  color: #555;
  transition: color 0.3s ease;
}

.dark-mode .voice-selector label {
  color: #b0b0b0;
}

.voice-selector select {
  width: 100%;
  padding: 8px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 0.95em;
  background: white;
  color: #333;
  transition: all 0.3s ease;
}

.dark-mode .voice-selector select {
  background: #3a3a3a;
  color: #e0e0e0;
  border-color: #555;
}

.appearances {
  font-size: 0.9em;
  color: #666;
  margin: 10px 0 0 0;
  transition: color 0.3s ease;
}

.dark-mode .appearances {
  color: #aaa;
}

.btn-primary, .btn-secondary {
  padding: 12px 30px;
  border: none;
  border-radius: 5px;
  font-size: 1em;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
}

.btn-primary {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
}

.btn-primary:hover {
  transform: translateY(-2px);
  box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
}

.btn-secondary {
  background: #4caf50;
  color: white;
  margin-top: 15px;
}

.btn-secondary:hover {
  background: #45a049;
}

.loading {
  text-align: center;
  padding: 20px;
  color: #667eea;
  font-weight: 600;
}

.dark-mode .loading {
  color: #81d4fa;
}

.success-message {
  background: #e8f5e9;
  padding: 20px;
  border-left: 4px solid #4caf50;
  border-radius: 4px;
  margin-top: 20px;
  transition: all 0.3s ease;
}

.dark-mode .success-message {
  background: #1b5e20;
  border-left-color: #81c784;
}

.success-message p {
  margin: 0 0 15px 0;
  color: #2e7d32;
  font-weight: 600;
  transition: color 0.3s ease;
}

.dark-mode .success-message p {
  color: #c8e6c9;
}

.audio-player {
  width: 100%;
  margin-top: 15px;
}

@media (max-width: 768px) {
  .app-header h1 {
    font-size: 1.8em;
  }
  
  .characters-list {
    grid-template-columns: 1fr;
  }
  
  .upload-area {
    padding: 20px;
  }
  
  .theme-toggle {
    position: static;
    margin-top: 15px;
  }
  
  .header-content {
    flex-direction: column;
  }
}
</style>
