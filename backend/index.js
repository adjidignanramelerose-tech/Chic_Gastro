import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { PrismaClient } from './generated/prisma/client.js'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { createServer } from 'http'
import { Server } from 'socket.io'
import QRCode from 'qrcode'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'

dotenv.config()

const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL })
const prisma = new PrismaClient({ adapter })
const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, { cors: { origin: '*' } })

app.use(cors())
app.use(express.json())

// ---------- AUTH ----------
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user || !(await bcrypt.compare(password, user.password)))
    return res.status(401).json({ error: 'Invalid credentials' })
  const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET)
  res.json({ token, user: { id: user.id, name: user.name, role: user.role } })
})

// ---------- MENU PUBLIC ----------
app.get('/api/menu', async (req, res) => {
  const categories = await prisma.category.findMany({
    include: { dishes: { where: { available: true } } },
    orderBy: { order: 'asc' }
  })
  res.json(categories)
})

app.get('/api/tables', async (req, res) => {
  res.json(await prisma.table.findMany({ orderBy: { number: 'asc' }}))
})

app.get('/api/tables/:qr', async (req, res) => {
  const table = await prisma.table.findUnique({ where: { qrCode: req.params.qr } })
  if (!table || !table.active) return res.status(404).json({ error: 'Table invalide' })
  res.json(table)
})

// ---------- COMMANDES ----------
app.post('/api/orders', async (req, res) => {
  const { tableId, items } = req.body
  const dishIds = items.map(i => i.dishId)
  const dishes = await prisma.dish.findMany({ where: { id: { in: dishIds } } })
  const total = items.reduce((sum, i) => {
    const d = dishes.find(x => x.id === i.dishId)
    return sum + d.price * i.quantity
  }, 0)

  const order = await prisma.order.create({
    data: {
      tableId, total, status: 'pending',
      items: { create: items.map(i => ({
        dishId: i.dishId, quantity: i.quantity,
        observation: i.observation || null,
        unitPrice: dishes.find(d => d.id === i.dishId).price
      }))}
    },
    include: { items: { include: { dish: true } }, table: true }
  })

  io.emit('order:new', order)
  res.status(201).json(order)
})

app.get('/api/orders', async (req, res) => {
  const { status } = req.query
  const orders = await prisma.order.findMany({
    where: status ? { status } : {},
    include: { items: { include: { dish: true } }, table: true },
    orderBy: { createdAt: 'desc' }
  })
  res.json(orders)
})

app.patch('/api/orders/:id/status', async (req, res) => {
  const { status } = req.body
  const order = await prisma.order.update({
    where: { id: +req.params.id },
    data: { status },
    include: { items: { include: { dish: true } }, table: true }
  })
  io.emit('order:updated', order)
  res.json(order)
})

// ---------- TABLES + QR ----------
app.post('/api/tables', async (req, res) => {
  const { number } = req.body
  const qrCode = `T${number}-${Date.now().toString(36)}`
  const table = await prisma.table.create({ data: { number, qrCode } })
  res.json(table)
})

app.get('/api/tables/:id/qr', async (req, res) => {
  const table = await prisma.table.findUnique({ where: { id: +req.params.id } })
  if (!table) return res.status(404).end()
  const url = `http://localhost:5173/menu?table=${table.qrCode}`
  const png = await QRCode.toBuffer(url, { width: 400 })
  res.type('png').send(png)
})

// ---------- SOCKET ----------
io.on('connection', s => console.log('🔌 client', s.id))

// ---------- SEED ----------
async function seed() {
  if (await prisma.user.count()) return
  const hash = await bcrypt.hash('admin123', 10)
  await prisma.user.createMany({ data: [
    { name: 'Admin',    email: 'admin@resto.com',  password: hash, role: 'admin' },
    { name: 'Cuisinier',email: 'cook@resto.com',   password: hash, role: 'cook' },
    { name: 'Serveur',  email: 'waiter@resto.com', password: hash, role: 'waiter' },
  ]})
  const cat = await prisma.category.create({ data: { name: 'Plats principaux', order: 1 }})
  await prisma.dish.createMany({ data: [
    { name: 'Poulet braisé',      price: 2500, categoryId: cat.id, description: 'Poulet grillé sauce maison' },
    { name: 'Riz sauce arachide', price: 1800, categoryId: cat.id },
    { name: 'Poisson grillé',     price: 3000, categoryId: cat.id },
  ]})
  for (let i = 1; i <= 5; i++) {
    await prisma.table.create({ data: { number: i, qrCode: `T${i}-seed` }})
  }
  console.log('✅ Seed OK — login: admin@resto.com / admin123')
}
seed()

const PORT = process.env.PORT || 4000
httpServer.listen(PORT, () => console.log(`🚀 API http://localhost:${PORT}`))
