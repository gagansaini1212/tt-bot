# Separate AI proposals from order authorization

The product uses AI to interpret market data and news, but customers authorize trading only within configured limits. AI proposes trade details within customer-selected assets and horizons; code checks each proposed order against limits before submission. This preserves AI discretion in choosing trades while making execution depend on explicit checks rather than the model's own assessment of compliance.
