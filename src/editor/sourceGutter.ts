import { RangeSetBuilder, type Extension } from '@codemirror/state'
import { GutterMarker, gutter } from '@codemirror/view'

class SourceMarker extends GutterMarker {
  private readonly source: string

  constructor(source: string) {
    super()
    this.source = source
  }

  toDOM(): Node {
    const element = document.createElement('span')
    element.className = 'cm-source-marker'
    element.textContent = this.source
    element.title = this.source
    return element
  }
}

export function sourceGutter(sources: Map<number, string>): Extension {
  return gutter({
    class: 'cm-source-gutter',
    markers(view) {
      const markers = new RangeSetBuilder<GutterMarker>()
      for (const [lineNumber, source] of sources) {
        if (lineNumber <= view.state.doc.lines) {
          const position = view.state.doc.line(lineNumber).from
          markers.add(position, position, new SourceMarker(source))
        }
      }
      return markers.finish()
    },
  })
}
