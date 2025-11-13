const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("PioneP2PEscrow - Sell PIO Flow", function () {
  let pioneEscrow;
  let mockOracle;
  let owner, seller, buyer, bridgeAdmin, feeRecipient;
  const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
  const BRIDGE_ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_ADMIN_ROLE"));

  // Constants
  const ORACLE_PRICE = ethers.parseUnits("0.5", 18); // 0.5 USD per PIO
  const PIO_AMOUNT = ethers.parseEther("100"); // 100 PIO
  const MIN_PER_TRADE = ethers.parseEther("10"); // 10 PIO
  const MAX_PER_TRADE = ethers.parseEther("50"); // 50 PIO
  const PRICE_PER_PIO = ethers.parseUnits("0.5", 18); // 0.5 USD per PIO

  beforeEach(async function () {
    [owner, seller, buyer, bridgeAdmin, feeRecipient] = await ethers.getSigners();

    // Deploy Mock Price Oracle
    const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
    mockOracle = await MockPriceOracle.deploy(ORACLE_PRICE);

    // Deploy PioneP2PEscrow
    const PioneP2PEscrow = await ethers.getContractFactory("PioneP2PEscrow");
    pioneEscrow = await PioneP2PEscrow.deploy(
      await mockOracle.getAddress(),
      feeRecipient.address
    );

    // Grant BRIDGE_ADMIN_ROLE to bridgeAdmin
    await pioneEscrow.grantRole(BRIDGE_ADMIN_ROLE, bridgeAdmin.address);
  });

  describe("Sell PIO Flow", function () {
    let orderId;

    describe("1. Create Sell PIO Order", function () {
      it("Should allow seller to create an order with valid PIO amount", async function () {
        const tx = await pioneEscrow.connect(seller).createOrder(
          MIN_PER_TRADE,
          MAX_PER_TRADE,
          PRICE_PER_PIO,
          { value: PIO_AMOUNT }
        );

        const receipt = await tx.wait();
        const event = receipt.logs.find(log => {
          try {
            return pioneEscrow.interface.parseLog(log).name === "OrderCreated";
          } catch (e) {
            return false;
          }
        });

        const parsedEvent = pioneEscrow.interface.parseLog(event);
        orderId = parsedEvent.args.orderId;

        expect(parsedEvent.args.seller).to.equal(seller.address);
        expect(parsedEvent.args.totalPIO).to.equal(PIO_AMOUNT);
        expect(parsedEvent.args.pricePerPIO).to.equal(PRICE_PER_PIO);

        // Verify order details
        const order = await pioneEscrow.getOrder(orderId);
        expect(order.seller).to.equal(seller.address);
        expect(order.totalPIO).to.equal(PIO_AMOUNT);
        expect(order.availablePIO).to.equal(PIO_AMOUNT);
        expect(order.minPerTrade).to.equal(MIN_PER_TRADE);
        expect(order.maxPerTrade).to.equal(MAX_PER_TRADE);
        expect(order.pricePerPIO).to.equal(PRICE_PER_PIO);
        expect(order.status).to.equal(1); // OrderStatus.Active
      });

      it("Should reject order with insufficient PIO amount", async function () {
        const tooSmallAmount = ethers.parseEther("0.1");
        await expect(
          pioneEscrow.connect(seller).createOrder(
            MIN_PER_TRADE,
            MAX_PER_TRADE,
            PRICE_PER_PIO,
            { value: tooSmallAmount }
          )
        ).to.be.revertedWith("Invalid range");
      });

      it("Should reject order with invalid min/max range", async function () {
        await expect(
          pioneEscrow.connect(seller).createOrder(
            MAX_PER_TRADE, // min > max
            MIN_PER_TRADE,
            PRICE_PER_PIO,
            { value: PIO_AMOUNT }
          )
        ).to.be.revertedWith("Invalid range");
      });

      it("Should reject order with price out of tolerance range", async function () {
        const outOfRangePrice = ethers.parseUnits("1.0", 18); // 100% higher than oracle
        await expect(
          pioneEscrow.connect(seller).createOrder(
            MIN_PER_TRADE,
            MAX_PER_TRADE,
            outOfRangePrice,
            { value: PIO_AMOUNT }
          )
        ).to.be.revertedWith("Price out of range");
      });
    });

    describe("2. Create Trade from BSC (Buyer pays USDT on BSC)", function () {
      let bscTradeId;
      const TRADE_PIO_AMOUNT = ethers.parseEther("30"); // 30 PIO

      beforeEach(async function () {
        // Create order first
        const tx = await pioneEscrow.connect(seller).createOrder(
          MIN_PER_TRADE,
          MAX_PER_TRADE,
          PRICE_PER_PIO,
          { value: PIO_AMOUNT }
        );

        const receipt = await tx.wait();
        const event = receipt.logs.find(log => {
          try {
            return pioneEscrow.interface.parseLog(log).name === "OrderCreated";
          } catch (e) {
            return false;
          }
        });
        orderId = pioneEscrow.interface.parseLog(event).args.orderId;
      });

      it("Should allow bridge admin to create trade", async function () {
        bscTradeId = ethers.keccak256(ethers.toUtf8Bytes("bsc_trade_1"));

        const tx = await pioneEscrow.connect(bridgeAdmin).createTrade(
          bscTradeId,
          orderId,
          buyer.address,
          TRADE_PIO_AMOUNT
        );

        const receipt = await tx.wait();
        const event = receipt.logs.find(log => {
          try {
            return pioneEscrow.interface.parseLog(log).name === "TradeCreated";
          } catch (e) {
            return false;
          }
        });

        const parsedEvent = pioneEscrow.interface.parseLog(event);
        expect(parsedEvent.args.tradeId).to.equal(bscTradeId);
        expect(parsedEvent.args.orderId).to.equal(orderId);
        expect(parsedEvent.args.buyer).to.equal(buyer.address);

        // Verify trade details
        const trade = await pioneEscrow.getSellPIOTrade(bscTradeId);
        expect(trade.orderId).to.equal(orderId);
        expect(trade.seller).to.equal(seller.address);
        expect(trade.buyer).to.equal(buyer.address);
        expect(trade.pioAmount).to.equal(TRADE_PIO_AMOUNT);
        expect(trade.status).to.equal(1); // TradeStatus.Created

        // Verify order's availablePIO is reduced
        const order = await pioneEscrow.getOrder(orderId);
        expect(order.availablePIO).to.equal(PIO_AMOUNT - TRADE_PIO_AMOUNT);
      });

      it("Should reject trade if not called by bridge admin", async function () {
        bscTradeId = ethers.keccak256(ethers.toUtf8Bytes("bsc_trade_1"));

        await expect(
          pioneEscrow.connect(seller).createTrade(
            bscTradeId,
            orderId,
            buyer.address,
            TRADE_PIO_AMOUNT
          )
        ).to.be.revertedWith("Only bridge admin");
      });

      it("Should reject trade with amount exceeding available PIO", async function () {
        bscTradeId = ethers.keccak256(ethers.toUtf8Bytes("bsc_trade_1"));
        const tooMuchPIO = PIO_AMOUNT + ethers.parseEther("1");

        await expect(
          pioneEscrow.connect(bridgeAdmin).createTrade(
            bscTradeId,
            orderId,
            buyer.address,
            tooMuchPIO
          )
        ).to.be.revertedWith("Insufficient PIO");
      });

      it("Should reject trade with amount below minPerTrade", async function () {
        bscTradeId = ethers.keccak256(ethers.toUtf8Bytes("bsc_trade_1"));
        const tooSmallAmount = ethers.parseEther("5"); // Less than MIN_PER_TRADE

        await expect(
          pioneEscrow.connect(bridgeAdmin).createTrade(
            bscTradeId,
            orderId,
            buyer.address,
            tooSmallAmount
          )
        ).to.be.revertedWith("Invalid amount");
      });
    });

    describe("3. Release PIO to Buyer", function () {
      let bscTradeId;
      const TRADE_PIO_AMOUNT = ethers.parseEther("30");

      beforeEach(async function () {
        // Create order
        let tx = await pioneEscrow.connect(seller).createOrder(
          MIN_PER_TRADE,
          MAX_PER_TRADE,
          PRICE_PER_PIO,
          { value: PIO_AMOUNT }
        );

        let receipt = await tx.wait();
        let event = receipt.logs.find(log => {
          try {
            return pioneEscrow.interface.parseLog(log).name === "OrderCreated";
          } catch (e) {
            return false;
          }
        });
        orderId = pioneEscrow.interface.parseLog(event).args.orderId;

        // Create trade
        bscTradeId = ethers.keccak256(ethers.toUtf8Bytes("bsc_trade_1"));
        await pioneEscrow.connect(bridgeAdmin).createTrade(
          bscTradeId,
          orderId,
          buyer.address,
          TRADE_PIO_AMOUNT
        );
      });

      it("Should release PIO to buyer with fee deduction", async function () {
        const buyerBalanceBefore = await ethers.provider.getBalance(buyer.address);
        const feeRecipientBalanceBefore = await ethers.provider.getBalance(feeRecipient.address);

        await pioneEscrow.connect(bridgeAdmin).releasePIOForBuyer(bscTradeId);

        const buyerBalanceAfter = await ethers.provider.getBalance(buyer.address);
        const feeRecipientBalanceAfter = await ethers.provider.getBalance(feeRecipient.address);

        // Calculate expected amounts
        const feePercent = await pioneEscrow.feePercent();
        const expectedFee = (TRADE_PIO_AMOUNT * feePercent) / 10000n;
        const expectedBuyerAmount = TRADE_PIO_AMOUNT - expectedFee;

        expect(buyerBalanceAfter - buyerBalanceBefore).to.equal(expectedBuyerAmount);
        expect(feeRecipientBalanceAfter - feeRecipientBalanceBefore).to.equal(expectedFee);

        // Verify trade status
        const trade = await pioneEscrow.getSellPIOTrade(bscTradeId);
        expect(trade.status).to.equal(2); // TradeStatus.Paid
      });

      it("Should reject if not called by bridge admin", async function () {
        await expect(
          pioneEscrow.connect(seller).releasePIOForBuyer(bscTradeId)
        ).to.be.revertedWith("Only bridge admin");
      });

      it("Should reject if trade status is not Created", async function () {
        // Release PIO first time
        await pioneEscrow.connect(bridgeAdmin).releasePIOForBuyer(bscTradeId);

        // Try to release again
        await expect(
          pioneEscrow.connect(bridgeAdmin).releasePIOForBuyer(bscTradeId)
        ).to.be.revertedWith("Invalid status");
      });
    });

    describe("4. Cancel Order", function () {
      beforeEach(async function () {
        const tx = await pioneEscrow.connect(seller).createOrder(
          MIN_PER_TRADE,
          MAX_PER_TRADE,
          PRICE_PER_PIO,
          { value: PIO_AMOUNT }
        );

        const receipt = await tx.wait();
        const event = receipt.logs.find(log => {
          try {
            return pioneEscrow.interface.parseLog(log).name === "OrderCreated";
          } catch (e) {
            return false;
          }
        });
        orderId = pioneEscrow.interface.parseLog(event).args.orderId;
      });

      it("Should allow seller to cancel order and refund remaining PIO", async function () {
        const sellerBalanceBefore = await ethers.provider.getBalance(seller.address);

        const tx = await pioneEscrow.connect(seller).cancelOrder(orderId);
        const receipt = await tx.wait();
        const gasUsed = receipt.gasUsed * receipt.gasPrice;

        const sellerBalanceAfter = await ethers.provider.getBalance(seller.address);

        // Verify refund (accounting for gas)
        expect(sellerBalanceAfter - sellerBalanceBefore + gasUsed).to.equal(PIO_AMOUNT);

        // Verify order status
        const order = await pioneEscrow.getOrder(orderId);
        expect(order.status).to.equal(3); // OrderStatus.Cancelled
        expect(order.availablePIO).to.equal(0);
      });

      it("Should reject if not called by seller or bridge admin", async function () {
        await expect(
          pioneEscrow.connect(buyer).cancelOrder(orderId)
        ).to.be.revertedWith("Not seller");
      });

      it("Should reject cancel if there are pending trades", async function () {
        // Create a trade
        const bscTradeId = ethers.keccak256(ethers.toUtf8Bytes("bsc_trade_1"));
        await pioneEscrow.connect(bridgeAdmin).createTrade(
          bscTradeId,
          orderId,
          buyer.address,
          MIN_PER_TRADE
        );

        // Try to cancel order
        await expect(
          pioneEscrow.connect(seller).cancelOrder(orderId)
        ).to.be.revertedWith("Trade not finalized");
      });
    });

    describe("5. Cancel Trade", function () {
      let bscTradeId;
      const TRADE_PIO_AMOUNT = ethers.parseEther("30");

      beforeEach(async function () {
        // Create order
        let tx = await pioneEscrow.connect(seller).createOrder(
          MIN_PER_TRADE,
          MAX_PER_TRADE,
          PRICE_PER_PIO,
          { value: PIO_AMOUNT }
        );

        let receipt = await tx.wait();
        let event = receipt.logs.find(log => {
          try {
            return pioneEscrow.interface.parseLog(log).name === "OrderCreated";
          } catch (e) {
            return false;
          }
        });
        orderId = pioneEscrow.interface.parseLog(event).args.orderId;

        // Create trade
        bscTradeId = ethers.keccak256(ethers.toUtf8Bytes("bsc_trade_1"));
        await pioneEscrow.connect(bridgeAdmin).createTrade(
          bscTradeId,
          orderId,
          buyer.address,
          TRADE_PIO_AMOUNT
        );
      });

      it("Should allow bridge admin to cancel trade and unlock PIO back to order", async function () {
        const orderBefore = await pioneEscrow.getOrder(orderId);
        const availableBefore = orderBefore.availablePIO;

        await pioneEscrow.connect(bridgeAdmin).cancelTrade(bscTradeId);

        const orderAfter = await pioneEscrow.getOrder(orderId);
        expect(orderAfter.availablePIO).to.equal(availableBefore + TRADE_PIO_AMOUNT);

        // Verify trade status
        const trade = await pioneEscrow.getSellPIOTrade(bscTradeId);
        expect(trade.status).to.equal(4); // TradeStatus.Cancelled
      });

      it("Should reject if not called by bridge admin", async function () {
        await expect(
          pioneEscrow.connect(seller).cancelTrade(bscTradeId)
        ).to.be.revertedWith("Only bridge admin");
      });
    });

    describe("6. Expire Trade", function () {
      let bscTradeId;
      const TRADE_PIO_AMOUNT = ethers.parseEther("30");

      beforeEach(async function () {
        // Create order
        let tx = await pioneEscrow.connect(seller).createOrder(
          MIN_PER_TRADE,
          MAX_PER_TRADE,
          PRICE_PER_PIO,
          { value: PIO_AMOUNT }
        );

        let receipt = await tx.wait();
        let event = receipt.logs.find(log => {
          try {
            return pioneEscrow.interface.parseLog(log).name === "OrderCreated";
          } catch (e) {
            return false;
          }
        });
        orderId = pioneEscrow.interface.parseLog(event).args.orderId;

        // Create trade
        bscTradeId = ethers.keccak256(ethers.toUtf8Bytes("bsc_trade_1"));
        await pioneEscrow.connect(bridgeAdmin).createTrade(
          bscTradeId,
          orderId,
          buyer.address,
          TRADE_PIO_AMOUNT
        );
      });

      it("Should allow bridge admin to expire trade and unlock PIO back to order", async function () {
        const orderBefore = await pioneEscrow.getOrder(orderId);
        const availableBefore = orderBefore.availablePIO;

        await pioneEscrow.connect(bridgeAdmin).expireTrade(bscTradeId);

        const orderAfter = await pioneEscrow.getOrder(orderId);
        expect(orderAfter.availablePIO).to.equal(availableBefore + TRADE_PIO_AMOUNT);

        // Verify trade status and sync flag
        const trade = await pioneEscrow.getSellPIOTrade(bscTradeId);
        expect(trade.status).to.equal(3); // TradeStatus.Expired
        expect(await pioneEscrow.crossChainExpireSynced(bscTradeId)).to.be.true;
      });
    });
  });
});
