# Own trading state outside eve sessions

Use PostgreSQL for trading state and a separate execution worker for order handling, while eve owns analysis and conversation. Protective actions must continue independently of model calls and conversational session lifetime, and repeated work must not submit duplicate orders. This adds a separate service and persistence boundary, but gives budget reservations, reconciliation, and exit deadlines a lifecycle controlled by the trading application.
