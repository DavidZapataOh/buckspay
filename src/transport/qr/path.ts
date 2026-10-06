/** One SVG path for the dark modules: a rectangle per horizontal run. */
export function qrPath(matrix: boolean[][]): string {
  let path = ''
  matrix.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue
      let end = x
      while (row[end + 1]) end++
      const width = end - x + 1
      path += `M${x} ${y}h${width}v1h-${width}z`
      x = end
    }
  })
  return path
}
