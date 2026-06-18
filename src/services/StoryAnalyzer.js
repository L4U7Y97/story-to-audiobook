import nlp from 'compromise'

class StoryAnalyzer {
  static async analyze(text) {
    // Split text into sentences
    const sentences = this.splitSentences(text)
    
    // Extract dialogue and narrative
    const characterMap = new Map()
    const narratorMap = new Map()
    
    sentences.forEach((sentence, index) => {
      const { character, narrator, type } = this.extractSpeaker(sentence)
      
      if (character) {
        if (!characterMap.has(character)) {
          characterMap.set(character, {
            id: characterMap.size + 1,
            name: character,
            type: 'Character',
            count: 1,
            voice: this.suggestVoice(character),
            appearances: [index]
          })
        } else {
          const existing = characterMap.get(character)
          existing.count++
          existing.appearances.push(index)
        }
      }
      
      if (narrator) {
        if (!narratorMap.has(narrator)) {
          narratorMap.set(narrator, {
            id: narratorMap.size + characterMap.size + 1,
            name: narrator,
            type: 'Narrator',
            count: 1,
            voice: 'neutral',
            appearances: [index]
          })
        } else {
          const existing = narratorMap.get(narrator)
          existing.count++
          existing.appearances.push(index)
        }
      }
    })
    
    // Combine and sort by appearances
    const characters = Array.from(characterMap.values())
    const narrators = Array.from(narratorMap.values())
    
    return {
      characters: [...characters, ...narrators].sort((a, b) => b.count - a.count),
      totalSentences: sentences.length,
      analysis: {
        characterCount: characters.length,
        narratorCount: narrators.length
      }
    }
  }

  static splitSentences(text) {
    // Basic sentence splitting - can be improved with more sophisticated NLP
    return text.match(/[^.!?]+[.!?]+/g) || [text]
  }

  static extractSpeaker(sentence) {
    // Pattern: "said John" or "John said" or dialogue patterns
    const dialoguePattern = /["'']([^"'']*)["'']/g
    const saidPattern = /(said|asked|replied|whispered|shouted|murmured)\s+([A-Z][a-z]+)/i
    const narratorPattern = /^(\w+\s+)?narrator|^(\w+\s+)?storyteller/i
    
    let character = null
    let narrator = null
    let type = 'action'
    
    // Check for dialogue
    const dialogueMatch = dialoguePattern.exec(sentence)
    if (dialogueMatch) {
      type = 'dialogue'
      
      // Try to extract speaker name after dialogue
      const saidMatch = saidPattern.exec(sentence)
      if (saidMatch) {
        character = saidMatch[2]
      }
    }
    
    // Check for narrator
    if (narratorPattern.test(sentence)) {
      narrator = 'Narrator'
      type = 'narration'
    }
    
    // Extract character names using NLP
    if (!character && type === 'dialogue') {
      const doc = nlp(sentence)
      const people = doc.people().out('array')
      if (people.length > 0) {
        character = people[0]
      }
    }
    
    return { character, narrator, type }
  }

  static suggestVoice(characterName) {
    // Simple heuristic for voice suggestion
    const maleNames = ['john', 'james', 'robert', 'michael', 'william', 'david', 'richard', 'joseph', 'thomas', 'charles']
    const femaleNames = ['mary', 'patricia', 'jennifer', 'linda', 'barbara', 'elizabeth', 'susan', 'jessica', 'sarah', 'karen']
    
    const nameLower = characterName.toLowerCase()
    
    if (maleNames.some(name => nameLower.includes(name))) {
      return 'male-young'
    } else if (femaleNames.some(name => nameLower.includes(name))) {
      return 'female-young'
    }
    
    return 'neutral'
  }
}

export default StoryAnalyzer
