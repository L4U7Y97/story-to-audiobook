import axios from 'axios'

class FileParser {
  static async parse(file) {
    const extension = file.name.split('.').pop().toLowerCase()
    
    switch (extension) {
      case 'txt':
        return this.parseTxt(file)
      case 'pdf':
        return this.parsePdf(file)
      case 'epub':
        return this.parseEpub(file)
      case 'docx':
        return this.parseDocx(file)
      default:
        throw new Error(`Unsupported file format: ${extension}`)
    }
  }

  static parseTxt(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = (e) => resolve(e.target.result)
      reader.onerror = reject
      reader.readAsText(file)
    })
  }

  static parsePdf(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = async (e) => {
        try {
          const { default: pdfParse } = await import('pdf-parse')
          const data = await pdfParse(e.target.result)
          const text = data.text
          resolve(text)
        } catch (error) {
          reject(error)
        }
      }
      reader.onerror = reject
      reader.readAsArrayBuffer(file)
    })
  }

  static parseEpub(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = async (e) => {
        try {
          const { default: EPub } = await import('epub')
          const epub = new EPub(e.target.result)
          await new Promise((resolveEpub) => epub.on('end', resolveEpub))
          
          let text = ''
          epub.spine.forEach((chapter) => {
            chapter.on('end', (section) => {
              text += section + ' '
            })
          })
          
          resolve(text)
        } catch (error) {
          reject(error)
        }
      }
      reader.onerror = reject
      reader.readAsArrayBuffer(file)
    })
  }

  static parseDocx(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = async (e) => {
        try {
          const { Document } = await import('js-docx')
          const doc = await Document.load(new Uint8Array(e.target.result))
          const text = doc.sections.map(section => 
            section.children.map(p => p.text).join('\n')
          ).join('\n')
          resolve(text)
        } catch (error) {
          reject(error)
        }
      }
      reader.onerror = reject
      reader.readAsArrayBuffer(file)
    })
  }
}

export default FileParser
