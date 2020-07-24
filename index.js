'use strict';

const { google } = require('googleapis');
const chromium = require('chrome-aws-lambda');
let sheets;
module.exports.handler = async () => {
  const auth = authorize();
  sheets = google.sheets({ version: 'v4', auth });
  const sheetList = await getSheetList();
  if(sheetList.length >= 200) {
    await deleteLastSheet();
  }
  const sheetName = new Date().toISOString().substring(0, 10);
  const [result, data] = await Promise.all([
    await addSheet(sheetName),
    await getData()
  ]);

  const sheetId = getSheetId(result);
  await writeToSheet(`${sheetName}!${getDataRange(data)}`, data);
  await formatSheet(sheetId, data);

  console.log(`finished writing data and formatting sheetId ${sheetId} (name "${sheetName}")`);
}

function authorize() {
  const oAuth2Client = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/gm, '\n')
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return oAuth2Client;
}

function addSheet(name) {
  return sheets.spreadsheets.batchUpdate({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    resource: {
      requests: [
        {
          addSheet: {
            properties: {
              title: name,
              index: 0
            }
          }
        }
      ]
    }
  });
}

function deleteLastSheet(sheetList) {
  const sheetId = sheetList[sheetList.length -1];
  return sheets.spreadsheets.batchUpdate({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    resource: {
      requests: [
        {
          deleteSheet: {
            sheetId
          }
        }
      ]
    }
  });
}

function writeToSheet(range, data) {
  return sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    range,
    resource: {
      values: data
    },
    valueInputOption: 'RAW'
  });
}

async function getSheetList() {
  const result = await sheets.spreadsheets.get({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID
  });
  return result.data.sheets.map(sheet => sheet.properties.sheetId);
}

function getDataRange(data){
  const start = 'A1';
  const end = String.fromCharCode(64+ data[0].length) + data.length;
  return `${start}:${end}`;
}

function formatSheet(sheetId, data) {
  return sheets.spreadsheets.batchUpdate({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    resource: {
      requests: [
        // add borders
        {
          updateBorders: {
            range: {
              sheetId: sheetId,
              startRowIndex: 1,
              endRowIndex: data.length,
              startColumnIndex: 0,
              endColumnIndex: 3
            },
            top: {
              style: 'SOLID',
              width: 1
            },
            bottom: {
              style: 'SOLID',
              width: 1
            },
            left: {
              style: 'SOLID',
              width: 1
            },
            right: {
              style: 'SOLID',
              width: 1
            },
            innerHorizontal: {
              style: 'SOLID',
              width: 1
            },
            innerVertical: {
              style: 'SOLID',
              width: 1
            },
          }
        },
        // make first row bold
        {
          repeatCell: {
            range: {
              sheetId: sheetId,
              startRowIndex: 1,
              endRowIndex: 2
            },
            cell: {
              userEnteredFormat: {
                textFormat: {
                  bold: true
                }
              }
            },
            fields: 'userEnteredFormat(textFormat,horizontalAlignment)'
          }
        },
        // make second and third columns centered horizontally
        {
          repeatCell: {
            range: {
              sheetId: sheetId,
              startColumnIndex: 0,
              endColumnIndex: 2
            },
            cell: {
              userEnteredFormat: {
                horizontalAlignment: 'CENTER',
              }
            },
            fields: 'userEnteredFormat(horizontalAlignment)'
          }
        },
        // cut unused columns and rows
        {
          updateSheetProperties: {
            properties: {
              sheetId,
              gridProperties: {
                rowCount: data.length,
                columnCount: data[0].length
              }
            },
            fields: 'gridProperties(rowCount, columnCount)'
          }
        },
        // autoresize columns
        {
          autoResizeDimensions: {
            dimensions: {
              sheetId,
              dimension: 'COLUMNS',
              startIndex: 0,
              endIndex: 2
            }
          }
        },
        {
          insertDimension: {
            range: {
              sheetId: sheetId,
              dimension: 'ROWS',
              startIndex: 0,
              endIndex: 1
            },
            inheritFromBefore: false
          }
        },
        {
          insertDimension: {
            range: {
              sheetId: sheetId,
              dimension: 'ROWS',
              startIndex: 2,
              endIndex: 3
            },
            inheritFromBefore: false
          }
        },
      ],
    }
  });
}

async function getData() {
  const browser = await chromium.puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath,
    headless: chromium.headless,
    ignoreHTTPSErrors: true,
  });
  const page = await browser.newPage();
  await page.setJavaScriptEnabled(false);
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.resourceType() === 'image') {
      request.abort();
    } else {
      request.continue();
    }
  });

  await page.goto(process.env.CRAWL_URL, {});

  let data = await page.evaluate(() => {
    const result = [['City', 'Temperature']];
    const table = document.querySelector('body > div.wrapper > div.main-content-div > section.bg--grey.pdflexi-t--small > div > section > div:nth-child(3) > div > table');
    for(let i = 1; i < table.rows.length; i++) {
      let tr = table.rows[i];
      result.push([
        tr.children[0].innerText.trim().replace('*', ''),
        tr.children[3].innerText.trim(),
      ]);
    }
    return result;
  });

  if(data.some(row => row[1].includes('F'))) {
    console.log('converting to celsius');
    // convert to celsius
    data = data.map((row, i) => {
      if(i === 0) {
        return row;
      }

      if(row[1] === 'N/A') {
        return row;
      }
      row[1] = `${Math.round((Number(row[1].split(' ')[0]) - 32) / 1.8)} °C`;
      return row;
    })
  }

  const sum = data.reduce((cur, next, i) => {
    if(i === 0) {
      return cur;
    }
    const value = Number(next[1].split(' ')[0]);
    if(isNaN(value)) {
      return cur;
    }
    return cur + value;
  }, 0);

  const avg = Math.round(sum / data.length -1);
  console.log('The average is:', avg);

  data.unshift(['Average', `${avg} °C`])
  return data;
}

function getSheetId(data) {
  return data.data.replies[0].addSheet.properties.sheetId;
}