// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// Registry screenshots for PDF Watermark, drawn by scripts/tool-screens.mjs:
//   node scripts/tool-screens.mjs pdf-watermark
//
// The sample PDFs are made inside the page with the pdf-lib copy the tool already carries.
// Their content is made up.

// Makes a small letter-like PDF with `pages` A4 pages and returns its bytes.
const MAKE_PDF = `
async function makePdf(title, pages) {
  var L = globalThis.PDFLib;
  var doc = await L.PDFDocument.create();
  doc.setTitle(title);
  var bold = await doc.embedFont(L.StandardFonts.HelveticaBold);
  var font = await doc.embedFont(L.StandardFonts.Helvetica);
  for (var p = 1; p <= pages; p++) {
    var page = doc.addPage([595, 842]);
    page.drawText(title, { x: 56, y: 770, size: 18, font: bold });
    page.drawText("Page " + p + " of " + pages, { x: 56, y: 748, size: 10, font: font });
    for (var y = 700; y > 120; y -= 18) {
      page.drawText("Sample text for the screenshot. None of it refers to a real person or company.", { x: 56, y: y, size: 10, font: font });
    }
  }
  return doc.save();
}
async function pickPdfs(list) {
  var dt = new DataTransfer();
  for (var i = 0; i < list.length; i++) {
    var bytes = await makePdf(list[i][1], list[i][2]);
    dt.items.add(new File([bytes], list[i][0], { type: "application/pdf" }));
  }
  var input = $("#picker");
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
`;

const FILES = JSON.stringify([
  ['tenancy-agreement.pdf', 'Tenancy agreement', 4],
  ['passport-copy.pdf', 'Passport copy', 1],
  ['bank-statement-october.pdf', 'Bank statement, October', 3],
  ['employment-contract.pdf', 'Employment contract', 6],
]);

export default {
  appId: 'sh.enigma.pdf-watermark',
  scenes: {
    'overview.png': ``,
    'settings.png': `
      type("#recipient", "Northwind Lettings");
      scrollToEl(".cols", 100);`,
    'results.png': `${MAKE_PDF}
      type("#recipient", "Northwind Lettings");
      await pickPdfs(${FILES});
      press("#run");
      await until(function () { return document.querySelectorAll(".status.done").length === 4; });
      scrollToEl("#h-queue");`,
  },
};
