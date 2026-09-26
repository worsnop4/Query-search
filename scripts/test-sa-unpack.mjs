import fs from 'node:fs'
import path from 'node:path'
import { parseSaUnpackWorkbook } from '../src/lib/saUnpack.js'

const templateDir = path.resolve('../Template file')
const saUnpackFile = path.join(templateDir, 'sa 9.10 unpack.xlsx')

console.log('--- Testing SA Unpack Parser ---')

if (fs.existsSync(saUnpackFile)) {
  console.log(`Reading SA Unpack file: ${saUnpackFile}`)
  const buf = fs.readFileSync(saUnpackFile)
  const { saName, rows } = parseSaUnpackWorkbook(buf)
  console.log(`SA Name: ${saName}`)
  console.log(`Parsed ${rows.length.toLocaleString()} rows.`)
  console.log('Sample row:', rows[0])

  const sections = new Set(rows.map((r) => r.section))
  console.log(`Distinct sections (${sections.size}):`, Array.from(sections).slice(0, 8), '...')

  const distinctCases = new Set(rows.map((r) => r.case_no))
  console.log(`Distinct cases: ${distinctCases.size.toLocaleString()}`)
} else {
  console.log(`File not found: ${saUnpackFile}`)
}
