import { getAll, getById, create, update, remove } from './invoicing.service.js';

export async function getAllInvoices(req, res, next) {
  try {
    const invoices = await getAll();
    res.json({ success: true, data: invoices });
  } catch (err) {
    next(err);
  }
}

export async function getInvoice(req, res, next) {
  try {
    const invoice = await getById(req.params.id);
    if (!invoice) return res.status(404).json({ success: false, message: 'Factura no encontrada' });
    res.json({ success: true, data: invoice });
  } catch (err) {
    next(err);
  }
}

export async function createInvoice(req, res, next) {
  try {
    const newInvoice = await create(req.body);
    res.status(201).json({ success: true, data: newInvoice });
  } catch (err) {
    next(err);
  }
}

export async function updateInvoice(req, res, next) {
  try {
    const updated = await update(req.params.id, req.body);
    if (!updated) return res.status(404).json({ success: false, message: 'Factura no encontrada' });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
}

export async function deleteInvoice(req, res, next) {
  try {
    await remove(req.params.id);
    res.json({ success: true, message: 'Factura eliminada' });
  } catch (err) {
    next(err);
  }
}
