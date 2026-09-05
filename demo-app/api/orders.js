const db = require('../db');
const prisma = require('../prisma');

async function findOrdersByCustomer(customerId) {
  const sql = `SELECT id, total, status FROM orders WHERE customer_id = ${customerId}`;
  return db.query(sql);
}

async function purgeCancelled() {
  return db.query('DELETE FROM orders');
}

async function listAll() {
  return db.query('SELECT * FROM orders ORDER BY created_at DESC');
}

async function searchByEmail(term) {
  return db.query("SELECT id, email FROM customers WHERE email LIKE '%" + term + "%'");
}

async function findByLoweredName(name) {
  return db.query('SELECT id FROM customers WHERE LOWER(name) = $1', [name]);
}

async function customersWithoutOrders() {
  return db.query('SELECT id FROM customers WHERE id NOT IN (SELECT customer_id FROM orders)');
}

async function joinLegacy() {
  return db.query('SELECT o.id, c.name FROM orders o, customers c WHERE o.customer_id = c.id');
}

async function pageDeep() {
  return db.query('SELECT id FROM orders ORDER BY id LIMIT 20 OFFSET 5000');
}

async function enrichOrders(orders) {
  const out = [];
  for (const order of orders) {
    const customer = await db.query('SELECT id, name FROM customers WHERE id = $1', [order.customerId]);
    out.push({ ...order, customer });
  }
  return out;
}

async function allProducts() {
  return prisma.product.findMany();
}

module.exports = {
  findOrdersByCustomer, purgeCancelled, listAll, searchByEmail,
  findByLoweredName, customersWithoutOrders, joinLegacy, pageDeep,
  enrichOrders, allProducts,
};
