          const express = require('express');
          const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
          const cors = require('cors');
          const nodemailer = require('nodemailer');
          require('dotenv').config();

          const app = express();
          const PORT = process.env.PORT || 3000;

          // Middleware
          app.use(cors());
          app.use(express.json({ limit: '10mb' }));

          // Email setup
          const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
              user: process.env.EMAIL_USER,
              pass: process.env.EMAIL_PASS
            }
          });

          // In-memory storage
          let purchases = [];

          // Create Stripe checkout session
          app.post('/create-checkout-session', async (req, res) => {
            try {
              const { customer, selection, image } = req.body;

              if (!customer.name || !customer.email || !selection || !image) {
                return res.status(400).json({ error: 'Missing required data' });
              }

              const session = await stripe.checkout.sessions.create({
                payment_method_types: ['card'],
                line_items: [
                  {
                    price_data: {
                      currency: 'usd',
                      product_data: {
                        name: 'LinkedIn Banner Pixels',
                        description: `${selection.blocks} pixels at position (${selection.x}, ${selection.y}) for 6 months`,
                      },
                      unit_amount: selection.cost * 100,
                    },
                    quantity: 1,
                  },
                ],
                mode: 'payment',
                customer_email: customer.email,
                metadata: {
                  customer_name: customer.name,
                  customer_company: customer.company || '',
                  customer_url: customer.url || '',
                  selection_x: selection.x.toString(),
                  selection_y: selection.y.toString(),
                  selection_width: selection.width.toString(),
                  selection_height: selection.height.toString(),
                  selection_blocks: selection.blocks.toString(),
                  purchase_id: Date.now().toString()
                },
                success_url: `${req.headers.origin}/success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${req.headers.origin}/`,
              });

              const purchaseData = {
                sessionId: session.id,
                customer,
                selection,
                image,
                status: 'pending',
                createdAt: new Date()
              };

              purchases.push(purchaseData);

              res.json({ sessionId: session.id, url: session.url });

            } catch (error) {
              console.error('Error creating checkout session:', error);
              res.status(500).json({ error: 'Failed to create checkout session' });
            }
          });

          // Health check
          app.get('/health', (req, res) => {
            res.json({ status: 'OK', message: 'Banner backend is running!' });
          });

          app.listen(PORT, () => {
            console.log(`🚀 Banner backend running on port ${PORT}`);
          });