const { expect } = require('chai')
const nock = require('nock')
const EmailHttpTransport = require('../../../../app/src/Features/Email/EmailHttpTransport')

const GATEWAY = 'https://mail.example.com'
const SEND_PATH = '/v1/send'

describe('EmailHttpTransport', function () {
  const message = {
    to: 'user@example.com',
    subject: 'Hello',
    html: '<p>hi</p>',
    text: 'hi',
  }

  beforeEach(function () {
    nock.cleanAll()
  })

  afterEach(function () {
    nock.cleanAll()
  })

  function client() {
    return EmailHttpTransport.createClient({
      url: GATEWAY + SEND_PATH,
      token: 'dummy-gateway-token',
    })
  }

  it('posts the message and returns the messageId', async function () {
    let received
    const scope = nock(GATEWAY, {
      reqheaders: { authorization: 'Bearer dummy-gateway-token' },
    })
      .post(SEND_PATH, body => {
        received = body
        return true
      })
      .reply(200, { messageId: 'm-123' })

    const result = await client().sendMail(message)

    expect(result.messageId).to.equal('m-123')
    expect(received).to.include({ to: message.to, subject: message.subject })
    expect(scope.isDone()).to.equal(true)
  })

  it('rejects with retryable=false on 4xx', async function () {
    nock(GATEWAY).post(SEND_PATH).reply(422, { error: 'bad address' })

    let error
    try {
      await client().sendMail(message)
    } catch (err) {
      error = err
    }

    expect(error).to.exist
    expect(error.message).to.match(/422/)
    expect(error.info).to.include({ statusCode: 422, retryable: false })
  })

  it('rejects with retryable=true on 5xx', async function () {
    nock(GATEWAY).post(SEND_PATH).reply(503, 'unavailable')

    let error
    try {
      await client().sendMail(message)
    } catch (err) {
      error = err
    }

    expect(error).to.exist
    expect(error.info).to.include({ statusCode: 503, retryable: true })
  })

  it('rejects with retryable=true on timeout', async function () {
    nock(GATEWAY).post(SEND_PATH).delayConnection(200).reply(200, {})

    let error
    try {
      await EmailHttpTransport.createClient({
        url: GATEWAY + SEND_PATH,
        token: 'dummy-gateway-token',
        timeoutMs: 50,
      }).sendMail(message)
    } catch (err) {
      error = err
    }

    expect(error).to.exist
    expect(error.info).to.include({ retryable: true })
  })

  it('requires a gateway url', function () {
    expect(() => EmailHttpTransport.createClient({})).to.throw(/url/)
  })

  describe('brevo provider', function () {
    const BREVO = 'https://api.brevo.com'
    const BREVO_PATH = '/v3/smtp/email'
    const BREVO_TOKEN = 'dummy-brevo-key'

    function brevoClient() {
      return EmailHttpTransport.createClient({
        url: BREVO + BREVO_PATH,
        token: BREVO_TOKEN,
        provider: 'brevo',
        senderName: 'FlyLaTeX',
        senderEmail: 'no-reply@example.com',
      })
    }

    it('maps the message to the Brevo payload and uses the api-key header', async function () {
      let received
      nock(BREVO, { reqheaders: { 'api-key': BREVO_TOKEN } })
        .post(BREVO_PATH, body => {
          received = body
          return true
        })
        .reply(201, { messageId: '<m@brevo>' })

      const result = await brevoClient().sendMail({
        to: 'user@example.com',
        subject: 'Hi',
        html: '<p>x</p>',
        text: 'x',
        replyTo: 'support@example.com',
      })

      expect(result.messageId).to.equal('<m@brevo>')
      expect(received).to.deep.equal({
        sender: { name: 'FlyLaTeX', email: 'no-reply@example.com' },
        to: [{ email: 'user@example.com' }],
        subject: 'Hi',
        htmlContent: '<p>x</p>',
        textContent: 'x',
        replyTo: { email: 'support@example.com' },
      })
    })

    it('requires a sender email', function () {
      expect(() =>
        EmailHttpTransport.createClient({
          url: BREVO + BREVO_PATH,
          token: BREVO_TOKEN,
          provider: 'brevo',
        })
      ).to.throw(/sender email/)
    })
  })
})
