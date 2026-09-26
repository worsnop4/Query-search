import fs from 'node:fs'
import path from 'node:path'
import {
  parseCaseContainerWorkbook,
  parseContainerDestinationWorkbook,
} from '../src/lib/caseDetails.js'

const templateDir = path.resolve('../Template file')
const caseContFile = path.join(templateDir, 'Case cont.xlsx')
const contDestFile = path.join(templateDir, 'cont dest.xlsx')

console.log('--- Testing New Case Details Parsers ---')

if (fs.existsSync(caseContFile)) {
  console.log(`Reading Case Cont file: ${caseContFile}`)
  const buf = fs.readFileSync(caseContFile)
  const rows = parseCaseContainerWorkbook(buf)
  console.log(`Parsed ${rows.length.toLocaleString()} rows from Case Cont file.`)
  console.log('Sample rows:', rows.slice(0, 3))
} else {
  console.log(`File not found: ${caseContFile}`)
}

console.log('')

if (fs.existsSync(contDestFile)) {
  console.log(`Reading Cont Dest file: ${contDestFile}`)
  const buf = fs.readFileSync(contDestFile)
  const rows = parseContainerDestinationWorkbook(buf)
  console.log(`Parsed ${rows.length.toLocaleString()} rows from Cont Dest file.`)
  console.log('Sample rows:', rows.slice(0, 3))
} else {
  console.log(`File not found: ${contDestFile}`)
}
