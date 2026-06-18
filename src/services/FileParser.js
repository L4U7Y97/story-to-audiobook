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
          const { getDocument } = await import('pdfjs-dist')
          const pdf = await getDocument(e.target.result).promise
          let text = ''
          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i)
            const textContent = await page.getTextContent()
            text += textContent.items.map(item => item.str).join(' ') + ' '
          }
          resolve(text)
        } catch (error) {
          console.error('PDF parsing error:', error)
          reject(new Error('Failed to parse PDF. Please ensure it contains extractable text.'))
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
          const JSZip = (await import('jszip')).default
          const zip = new JSZip()
          await zip.loadAsync(e.target.result)
          
          let text = ''
          const promises = []
          
          zip.forEach((relativePath, file) => {
            if (relativePath.includes('.xhtml') || relativePath.includes('.html')) {
              promises.push(
                file.async('string').then(content => {
                  const parser = new DOMParser()
                  const doc = parser.parseFromString(content, 'text/html')
                  text += doc.body.innerText + ' '
                })
              )
            }
          })
          
          await Promise.all(promises)
          resolve(text)
        } catch (error) {
          console.error('EPUB parsing error:', error)
          reject(new Error('Failed to parse EPUB file.'))
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
          const JSZip = (await import('jszip')).default
          const zip = new JSZip()
          await zip.loadAsync(e.target.result)
          
          const xmlContent = await zip.file('word/document.xml').async('string')
          const parser = new DOMParser()
          const doc = parser.parseFromString(xmlContent, 'text/xml')
          
          const paragraphs = doc.querySelectorAll('w\\:p, p')
          let text = ''
          paragraphs.forEach(p => {
            const texts = p.querySelectorAll('w\\:t, t')
            texts.forEach(t => {
              text += t.textContent
            })
            text += '\n'
          })
          
          resolve(text)
        } catch (error) {
          console.error('DOCX parsing error:', error)
          reject(new Error('Failed to parse DOCX file.'))
        }
      }
      reader.onerror = reject
      reader.readAsArrayBuffer(file)
    })
  }
}

export default FileParser
