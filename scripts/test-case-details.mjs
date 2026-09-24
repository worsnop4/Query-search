import fs from 'node:fs'
import path from 'node:path'
import {
  parseShippingAdviceWorkbook,
  parseUnpackLabelWorkbook,
} from '../src/lib/caseDetails.js'

const templateDir = path.resolve('../Template file')
const saFile = path.join(templateDir, 'sa and destination.xlsx')
const unpackFile = path.join(templateDir, 'unpacklabel.xlsx')

console.log('--- Testing Case Details Parsers ---')

if (fs.existsSync(saFile)) {
  console.log(`Reading SA file: ${saFile}`)
  const buf = fs.readFileSync(saFile)
  const rows = parseShippingAdviceWorkbook(buf)
  console.log(`Parsed ${rows.length.toLocaleString()} rows from SA file.`)
  console.log('Sample row:', rows[0])
  const withDest = rows.filter((r) => r.unload_destination)
  console.log(`Rows with unload_destination: ${withDest.length.toLocaleString()}`)
  if (withDest.length > 0) {
    console.log('Sample with destination:', withDest[0])
  }
} else {
  console.log(`File not found: ${saFile}`)
}

console.log('')

if (fs.existsSync(unpackFile)) {
  console.log(`Reading Unpack file: ${unpackFile}`)
  const buf = fs.readFileSync(unpackFile)
  const rows = parseUnpackLabelWorkbook(buf)
  console.log(`Parsed ${rows.length.toLocaleString()} rows from Unpack file.`)
  console.log('Sample row:', rows[0])
  const sampleNonOk = rows.filter((r) => r.unpack_number && r.unpack_number !== 'OK-KIRIM')
  console.log(`Rows with custom unpack number: ${sampleNonOk.length.toLocaleString()}`)
  if (sampleNonOk.length > 0) {
    console.log('Sample custom unpack:', sampleNonOk[0])
  }
} else {
  console.log(`File not found: ${unpackFile}`)
}
