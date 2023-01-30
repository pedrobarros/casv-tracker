require('dotenv').config();

const sgMail = require('@sendgrid/mail')
const dayjs = require('dayjs');
const fs = require('fs');
const util = require('util');
const readFile = util.promisify(fs.readFile);

const { EMAIL_FROM, EMAIL_TO, SENDGRID_API_KEY } = process.env;

sgMail.setApiKey(SENDGRID_API_KEY);

main().then(() => { });

async function main() {
  const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');

  return readFile(`logs/${yesterday}.txt`, 'utf-8').then(sendEmail).catch(console.log);
}


function sendEmail(data) {
  const html = data.replace(/\n/g, '<br />');

  const email = {
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject: 'Report CASV',
    text: data,
    html,
  }

  return sgMail
    .send(email)
    .then(() => {
      console.log("Email enviado com sucesso!")
    })
}