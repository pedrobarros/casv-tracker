require('dotenv').config();

const puppeteer = require('puppeteer');
const sgMail = require('@sendgrid/mail')
const dayjs = require('dayjs');
const fs = require('fs');
const util = require('util');
const appendFile = util.promisify(fs.appendFile);

const { LOGIN_URL, LOGIN_EMAIL, LOGIN_PASSWORD, SENDGRID_API_KEY, SCHEDULE_URL, EMAIL_FROM, EMAIL_TO, HEADLESS } = process.env;

sgMail.setApiKey(SENDGRID_API_KEY);

const now = dayjs().format();
log(`############### Iniciando script - ${now} ###############`);

main()
  .then(() => {
    log(`############### Script finalizado com sucesso ###############`);
  })
  .catch((error) => {
    log(error);
    log(`############### Falha ao executar o script ###############`);
  });

async function main() {
  const { browser, page } = await openBrowser();

  try {
    await login(page);
    const currentSchedule = await getCurrentSchedule(page);

    await gotToScheduler(page);

    let startDate = '2023-01-01';

    while (true) {
      const selectedDay = await searchAndClickOnNextAvailableDay(page, startDate, currentSchedule);
      if (!selectedDay) break;

      const selectedTime = await getAvailableTime(page);

      if (selectedTime) {
        await sendEmail(`${selectedDay} ${selectedTime}`);
        break;
      } else {
        startDate = selectedDay;
      }
    }
  } catch (error) {
    throw error;
  } finally {
    await closeBrowser(browser);
  }
}


async function openBrowser() {
  log("Iniciando browser...");
  const browser = await puppeteer.launch({ headless: HEADLESS === "true", args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1024 });
  page.setDefaultNavigationTimeout(300_000);

  return { browser, page };
}

async function login(page) {
  log("Fazendo login...");
  await page.goto(LOGIN_URL);

  await page.type('#user_email', LOGIN_EMAIL);
  await page.type('#user_password', LOGIN_PASSWORD);
  await page.click('#policy_confirmed');
  await page.click("[name='commit']");

  await page.waitForSelector(
    'text/Continuar'
  );
}

async function getCurrentSchedule(page) {
  log("Buscando agendamento atual...");
  let text = await page.$eval('.consular-appt', el => el.textContent);
  text = text.replace("Agendamento consular:\n", "").trim();

  const months = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

  const data = text.match(/^(\d+) ([^ ,]+), (\d+)/);
  const day = String(Number(data[1])).padStart(2, "0");
  const month = data[2];
  const year = data[3];

  const monthNumber = String(months.indexOf(month) + 1).padStart(2, "0");

  return `${year}-${monthNumber}-${day}`;
}

async function gotToScheduler(page) {
  log("Navegando para rota de agendamento...");
  await page.goto(SCHEDULE_URL);

  await page.waitForSelector("#appointments_consulate_appointment_date");
  await page.waitForTimeout(1000);
}

function closeBrowser(browser) {
  log("Fechando browser...");
  return browser.close();
}

function getMonthAndYear(monthInEnglish, year) {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  const month = String(months.indexOf(monthInEnglish) + 1).padStart(2, "0");

  return `${year}-${month}`;
}

async function getCurrentMonth(page) {
  const month = await page.$eval(".ui-datepicker-group-first .ui-datepicker-month", el => el.textContent);
  const year = await page.$eval(".ui-datepicker-group-first .ui-datepicker-year", el => el.textContent);
  return getMonthAndYear(month, year);
}

async function goToNextMonth(page) {
  await page.click(".ui-datepicker-next");
  await page.waitForTimeout(300);
  return await getCurrentMonth(page);
}

async function clickOnFirstAvailableDay(page, currentMonth, startMonth, startDay, endMonth, endDay) {
  const days = await page.$$(".ui-datepicker-group-first .ui-datepicker-calendar a");
  let firstAvailableDay = null;

  for (let d = 0; d < days.length; d++) {
    const day = String(await days[d].evaluate(el => el.textContent)).padStart(2, "0");
    if (currentMonth === startMonth && day <= startDay) continue;
    if (currentMonth === endMonth && day >= endDay) break;

    firstAvailableDay = day;
    log(`Selecionando dia ${currentMonth}-${day}...`);
    await days[d].click();
    await page.waitForTimeout(2000);
    break;
  }

  return firstAvailableDay;
}

async function searchAndClickOnNextAvailableDay(page, startDate, endDate) {
  log(`Buscando dias disponíveis entre ${startDate} e ${endDate}...`)

  try {
    await page.waitForSelector("#appointments_consulate_appointment_date", {
      visible: true,
      timeout: 3000
    });
  } catch (e) {
    log("Seleção de dia não disponível no momento.");
    return null;
  }

  await page.click("#appointments_consulate_appointment_date");
  await page.waitForTimeout(1000);

  const start = startDate.match(/^(\d+-\d+)-(\d+)/);
  const startMonth = start[1];
  const startDay = start[2];

  const end = endDate.match(/^(\d+-\d+)-(\d+)/);
  const endMonth = end[1];
  const endDay = end[2];

  let currentMonth = await getCurrentMonth(page);

  while (currentMonth < startMonth) {
    currentMonth = await goToNextMonth(page);
  }

  let selectedDay = null;

  while (currentMonth <= endMonth) {
    selectedDay = await clickOnFirstAvailableDay(page, currentMonth, startMonth, startDay, endMonth, endDay);
    if (selectedDay === null) {
      currentMonth = await goToNextMonth(page);
    } else {
      break;
    }
  }

  if (!selectedDay) {
    log("Nenhum dia disponível no calendário.");
    return null;
  }

  return `${currentMonth}-${selectedDay}`;
}

async function getAvailableTime(page) {
  log("Checando horários disponíveis...");
  const timeOptions = await page.$$("#appointments_consulate_appointment_time option[value]");
  let availableTime = null;

  for (let i = timeOptions.length - 1; i >= 0; i--) {
    const option = timeOptions[i].evaluate(el => el.value);
    await page.select("#appointments_consulate_appointment_time", option);

    try {
      await page.waitForSelector('#appointments_asc_appointment_date', {
        visible: true,
        timeout: 3000
      });

      availableTime = option;
      break;
    } catch (e) { }
  }

  if (availableTime) {
    log("Horário disponível encontrado: " + availableTime);
  } else {
    log("Nenhum horário disponível encontrado");
  }

  return availableTime;
}

function sendEmail(date) {
  log(`Enviando email com data ${date}...`);

  const email = {
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject: 'Re: Data CASV',
    text: date,
    html: date,
  }

  return sgMail
    .send(email)
    .then(() => {
      log("Email enviado com sucesso!");
    })
}

function log(text) {
  const now = dayjs().format("YYYY-MM-DD");
  return appendFile(`logs/${now}.txt`, text + "\n");
}