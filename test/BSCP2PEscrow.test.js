const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("BSCP2PEscrow - Sell USDT Flow", function () {
  let bscEscrow;
  let mockUSDT;
  let mockPIO;
  let mockPair;
  let owner, seller, buyer, bridgeAdmin, feeRecipient;
  const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
  const BRIDGE_ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_ADMIN_ROLE"));

  // Constants
  const USDT_DECIMALS = 18;
  const USDT_AMOUNT = ethers.parseUnits("1000", USDT_DECIMALS); // 1000 USDT
  const MIN_PER_TRADE = ethers.parseUnits("100", USDT_DECIMALS); // 100 USDT
  const MAX_PER_TRADE = ethers.parseUnits("500", USDT_DECIMALS); // 500 USDT
  const PRICE_PER_PIO = ethers.parseUnits("0.5", 18); // 0.5 USD per PIO

  // Pancake reserves (for price calculation)
  const PIO_RESERVE = ethers.parseEther("1000000"); // 1M PIO
  const USDT_RESERVE = ethers.parseUnits("500000", USDT_DECIMALS); // 500k USDT -> price = 0.5 USDT per PIO

  beforeEach(async function () {
    [owner, seller, buyer, bridgeAdmin, feeRecipient] = await ethers.getSigners();

    // Deploy Mock USDT
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    mockUSDT = await MockERC20.deploy("Mock USDT", "USDT");
    mockPIO = await MockERC20.deploy("Mock PIO", "PIO");

    // Deploy Mock PancakePair
    const MockPancakePair = await ethers.getContractFactory("MockPancakePair");
    mockPair = await MockPancakePair.deploy(
      await mockPIO.getAddress(),
      await mockUSDT.getAddress()
    );
    await mockPair.setReserves(PIO_RESERVE, USDT_RESERVE);

    // Deploy BSCP2PEscrow
    const BSCP2PEscrow = await ethers.getContractFactory("BSCP2PEscrow");
    bscEscrow = await BSCP2PEscrow.deploy(
      await mockUSDT.getAddress(),
      await mockPIO.getAddress(),
      await mockPair.getAddress(),
      feeRecipient.address
    );

    // Grant BRIDGE_ADMIN_ROLE to bridgeAdmin
    await bscEscrow.grantRole(BRIDGE_ADMIN_ROLE, bridgeAdmin.address);

    // Mint USDT to seller and buyer
    await mockUSDT.mint(seller.address, USDT_AMOUNT * 10n);
    await mockUSDT.mint(buyer.address, USDT_AMOUNT * 10n);

    // Approve escrow to spend USDT
    await mockUSDT.connect(seller).approve(await bscEscrow.getAddress(), ethers.MaxUint256);
    await mockUSDT.connect(buyer).approve(await bscEscrow.getAddress(), ethers.MaxUint256);
  });

  describe("Sell USDT Flow", function () {
    let orderId;

    describe("1. Create Sell USDT Order", function () {
      it("Should allow seller to create an order with valid USDT amount", async function () {
        const tx = await bscEscrow.connect(seller).createOrder(
          USDT_AMOUNT,
          MIN_PER_TRADE,
          MAX_PER_TRADE,
          PRICE_PER_PIO
        );

        const receipt = await tx.wait();
        const event = receipt.logs.find(log => {
          try {
            return bscEscrow.interface.parseLog(log).name === "OrderCreated";
          } catch (e) {
            return false;
          }
        });

        const parsedEvent = bscEscrow.interface.parseLog(event);
        orderId = parsedEvent.args.orderId;

        expect(parsedEvent.args.seller).to.equal(seller.address);
        expect(parsedEvent.args.totalUSDT).to.equal(USDT_AMOUNT);
        expect(parsedEvent.args.pricePerPIO).to.equal(PRICE_PER_PIO);

        // Verify order details
        const order = await bscEscrow.getOrder(orderId);
        expect(order.seller).to.equal(seller.address);
        expect(order.totalUSDT).to.equal(USDT_AMOUNT);
        expect(order.availableUSDT).to.equal(USDT_AMOUNT);
        expect(order.minPerTrade).to.equal(MIN_PER_TRADE);
        expect(order.maxPerTrade).to.equal(MAX_PER_TRADE);
        expect(order.pricePerPIO).to.equal(PRICE_PER_PIO);
        expect(order.status).to.equal(1); // OrderStatus.Active

        // Verify USDT is transferred to contract
        expect(await mockUSDT.balanceOf(await bscEscrow.getAddress())).to.equal(USDT_AMOUNT);
      });

      it("Should reject order with insufficient USDT amount", async function () {
        const tooSmallAmount = ethers.parseUnits("1", USDT_DECIMALS);
        await expect(
          bscEscrow.connect(seller).createOrder(
            tooSmallAmount,
            MIN_PER_TRADE,
            MAX_PER_TRADE,
            PRICE_PER_PIO
          )
        ).to.be.revertedWith("Invalid range");
      });

      it("Should reject order with invalid min/max range", async function () {
        await expect(
          bscEscrow.connect(seller).createOrder(
            USDT_AMOUNT,
            MAX_PER_TRADE, // min > max
            MIN_PER_TRADE,
            PRICE_PER_PIO
          )
        ).to.be.revertedWith("Invalid range");
      });

      it("Should reject order with price out of tolerance range", async function () {
        const outOfRangePrice = ethers.parseUnits("1.0", 18); // 100% higher than current price
        await expect(
          bscEscrow.connect(seller).createOrder(
            USDT_AMOUNT,
            MIN_PER_TRADE,
            MAX_PER_TRADE,
            outOfRangePrice
          )
        ).to.be.revertedWith("Price out of range");
      });
    });

    describe("2. Create Trade from Pione (Buyer pays PIO on Pione)", function () {
      let pioneTradeId;
      const TRADE_USDT_AMOUNT = ethers.parseUnits("300", USDT_DECIMALS); // 300 USDT

      beforeEach(async function () {
        // Create order first
        const tx = await bscEscrow.connect(seller).createOrder(
          USDT_AMOUNT,
          MIN_PER_TRADE,
          MAX_PER_TRADE,
          PRICE_PER_PIO
        );

        const receipt = await tx.wait();
        const event = receipt.logs.find(log => {
          try {
            return bscEscrow.interface.parseLog(log).name === "OrderCreated";
          } catch (e) {
            return false;
          }
        });
        orderId = bscEscrow.interface.parseLog(event).args.orderId;
      });

      it("Should allow bridge admin to create trade", async function () {
        pioneTradeId = ethers.keccak256(ethers.toUtf8Bytes("pione_trade_1"));

        const tx = await bscEscrow.connect(bridgeAdmin).createTrade(
          pioneTradeId,
          orderId,
          buyer.address,
          TRADE_USDT_AMOUNT
        );

        const receipt = await tx.wait();
        const event = receipt.logs.find(log => {
          try {
            return bscEscrow.interface.parseLog(log).name === "TradeCreated";
          } catch (e) {
            return false;
          }
        });

        const parsedEvent = bscEscrow.interface.parseLog(event);
        expect(parsedEvent.args.tradeId).to.equal(pioneTradeId);
        expect(parsedEvent.args.orderId).to.equal(orderId);
        expect(parsedEvent.args.buyer).to.equal(buyer.address);

        // Verify trade details
        const trade = await bscEscrow.getSellUSDTTrade(pioneTradeId);
        expect(trade.orderId).to.equal(orderId);
        expect(trade.seller).to.equal(seller.address);
        expect(trade.buyer).to.equal(buyer.address);
        expect(trade.usdtAmount).to.equal(TRADE_USDT_AMOUNT);
        expect(trade.status).to.equal(1); // TradeStatus.Created

        // Verify order's availableUSDT is reduced
        const order = await bscEscrow.getOrder(orderId);
        expect(order.availableUSDT).to.equal(USDT_AMOUNT - TRADE_USDT_AMOUNT);
      });

      it("Should reject trade if not called by bridge admin", async function () {
        pioneTradeId = ethers.keccak256(ethers.toUtf8Bytes("pione_trade_1"));

        await expect(
          bscEscrow.connect(seller).createTrade(
            pioneTradeId,
            orderId,
            buyer.address,
            TRADE_USDT_AMOUNT
          )
        ).to.be.revertedWith("Only bridge admin");
      });

      it("Should reject trade with amount exceeding available USDT", async function () {
        pioneTradeId = ethers.keccak256(ethers.toUtf8Bytes("pione_trade_1"));
        const tooMuchUSDT = USDT_AMOUNT + ethers.parseUnits("1", USDT_DECIMALS);

        await expect(
          bscEscrow.connect(bridgeAdmin).createTrade(
            pioneTradeId,
            orderId,
            buyer.address,
            tooMuchUSDT
          )
        ).to.be.revertedWith("Insufficient USDT");
      });

      it("Should reject trade with amount below minPerTrade", async function () {
        pioneTradeId = ethers.keccak256(ethers.toUtf8Bytes("pione_trade_1"));
        const tooSmallAmount = ethers.parseUnits("50", USDT_DECIMALS); // Less than MIN_PER_TRADE

        await expect(
          bscEscrow.connect(bridgeAdmin).createTrade(
            pioneTradeId,
            orderId,
            buyer.address,
            tooSmallAmount
          )
        ).to.be.revertedWith("Invalid amount");
      });

      it("Should reject duplicate trade ID", async function () {
        pioneTradeId = ethers.keccak256(ethers.toUtf8Bytes("pione_trade_1"));

        // Create first trade
        await bscEscrow.connect(bridgeAdmin).createTrade(
          pioneTradeId,
          orderId,
          buyer.address,
          TRADE_USDT_AMOUNT
        );

        // Try to create with same ID
        await expect(
          bscEscrow.connect(bridgeAdmin).createTrade(
            pioneTradeId,
            orderId,
            buyer.address,
            TRADE_USDT_AMOUNT
          )
        ).to.be.revertedWith("Trade exists");
      });
    });

    describe("3. Release USDT to Buyer", function () {
      let pioneTradeId;
      const TRADE_USDT_AMOUNT = ethers.parseUnits("300", USDT_DECIMALS);

      beforeEach(async function () {
        // Create order
        let tx = await bscEscrow.connect(seller).createOrder(
          USDT_AMOUNT,
          MIN_PER_TRADE,
          MAX_PER_TRADE,
          PRICE_PER_PIO
        );

        let receipt = await tx.wait();
        let event = receipt.logs.find(log => {
          try {
            return bscEscrow.interface.parseLog(log).name === "OrderCreated";
          } catch (e) {
            return false;
          }
        });
        orderId = bscEscrow.interface.parseLog(event).args.orderId;

        // Create trade
        pioneTradeId = ethers.keccak256(ethers.toUtf8Bytes("pione_trade_1"));
        await bscEscrow.connect(bridgeAdmin).createTrade(
          pioneTradeId,
          orderId,
          buyer.address,
          TRADE_USDT_AMOUNT
        );
      });

      it("Should release USDT to buyer with fee deduction", async function () {
        const buyerBalanceBefore = await mockUSDT.balanceOf(buyer.address);
        const feeRecipientBalanceBefore = await mockUSDT.balanceOf(feeRecipient.address);

        await bscEscrow.connect(bridgeAdmin).releaseUSDTForBuyer(pioneTradeId);

        const buyerBalanceAfter = await mockUSDT.balanceOf(buyer.address);
        const feeRecipientBalanceAfter = await mockUSDT.balanceOf(feeRecipient.address);

        // Calculate expected amounts
        const feePercent = await bscEscrow.feePercent();
        const expectedFee = (TRADE_USDT_AMOUNT * feePercent) / 10000n;
        const expectedBuyerAmount = TRADE_USDT_AMOUNT - expectedFee;

        expect(buyerBalanceAfter - buyerBalanceBefore).to.equal(expectedBuyerAmount);
        expect(feeRecipientBalanceAfter - feeRecipientBalanceBefore).to.equal(expectedFee);

        // Verify trade status
        const trade = await bscEscrow.getSellUSDTTrade(pioneTradeId);
        expect(trade.status).to.equal(2); // TradeStatus.Paid
      });

      it("Should reject if not called by bridge admin", async function () {
        await expect(
          bscEscrow.connect(seller).releaseUSDTForBuyer(pioneTradeId)
        ).to.be.revertedWith("Only bridge admin");
      });

      it("Should reject if trade status is not Created", async function () {
        // Release USDT first time
        await bscEscrow.connect(bridgeAdmin).releaseUSDTForBuyer(pioneTradeId);

        // Try to release again
        await expect(
          bscEscrow.connect(bridgeAdmin).releaseUSDTForBuyer(pioneTradeId)
        ).to.be.revertedWith("Invalid status");
      });
    });

    describe("4. Cancel Order", function () {
      beforeEach(async function () {
        const tx = await bscEscrow.connect(seller).createOrder(
          USDT_AMOUNT,
          MIN_PER_TRADE,
          MAX_PER_TRADE,
          PRICE_PER_PIO
        );

        const receipt = await tx.wait();
        const event = receipt.logs.find(log => {
          try {
            return bscEscrow.interface.parseLog(log).name === "OrderCreated";
          } catch (e) {
            return false;
          }
        });
        orderId = bscEscrow.interface.parseLog(event).args.orderId;
      });

      it("Should allow seller to cancel order and refund remaining USDT", async function () {
        const sellerBalanceBefore = await mockUSDT.balanceOf(seller.address);

        await bscEscrow.connect(seller).cancelOrder(orderId);

        const sellerBalanceAfter = await mockUSDT.balanceOf(seller.address);

        // Verify refund
        expect(sellerBalanceAfter - sellerBalanceBefore).to.equal(USDT_AMOUNT);

        // Verify order status
        const order = await bscEscrow.getOrder(orderId);
        expect(order.status).to.equal(3); // OrderStatus.Cancelled
        expect(order.availableUSDT).to.equal(0);
      });

      it("Should reject if not called by seller or bridge admin", async function () {
        await expect(
          bscEscrow.connect(buyer).cancelOrder(orderId)
        ).to.be.revertedWith("Not seller");
      });

      it("Should reject cancel if there are pending trades", async function () {
        // Create a trade
        const pioneTradeId = ethers.keccak256(ethers.toUtf8Bytes("pione_trade_1"));
        await bscEscrow.connect(bridgeAdmin).createTrade(
          pioneTradeId,
          orderId,
          buyer.address,
          MIN_PER_TRADE
        );

        // Try to cancel order
        await expect(
          bscEscrow.connect(seller).cancelOrder(orderId)
        ).to.be.revertedWith("Trade not finalized");
      });
    });

    describe("5. Cancel Trade", function () {
      let pioneTradeId;
      const TRADE_USDT_AMOUNT = ethers.parseUnits("300", USDT_DECIMALS);

      beforeEach(async function () {
        // Create order
        let tx = await bscEscrow.connect(seller).createOrder(
          USDT_AMOUNT,
          MIN_PER_TRADE,
          MAX_PER_TRADE,
          PRICE_PER_PIO
        );

        let receipt = await tx.wait();
        let event = receipt.logs.find(log => {
          try {
            return bscEscrow.interface.parseLog(log).name === "OrderCreated";
          } catch (e) {
            return false;
          }
        });
        orderId = bscEscrow.interface.parseLog(event).args.orderId;

        // Create trade
        pioneTradeId = ethers.keccak256(ethers.toUtf8Bytes("pione_trade_1"));
        await bscEscrow.connect(bridgeAdmin).createTrade(
          pioneTradeId,
          orderId,
          buyer.address,
          TRADE_USDT_AMOUNT
        );
      });

      it("Should allow bridge admin to cancel trade and unlock USDT back to order", async function () {
        const orderBefore = await bscEscrow.getOrder(orderId);
        const availableBefore = orderBefore.availableUSDT;

        await bscEscrow.connect(bridgeAdmin).cancelTrade(pioneTradeId);

        const orderAfter = await bscEscrow.getOrder(orderId);
        expect(orderAfter.availableUSDT).to.equal(availableBefore + TRADE_USDT_AMOUNT);

        // Verify trade status
        const trade = await bscEscrow.getSellUSDTTrade(pioneTradeId);
        expect(trade.status).to.equal(4); // TradeStatus.Cancelled
      });

      it("Should reject if not called by bridge admin", async function () {
        await expect(
          bscEscrow.connect(seller).cancelTrade(pioneTradeId)
        ).to.be.revertedWith("Only bridge admin");
      });
    });

    describe("6. Expire Trade", function () {
      let pioneTradeId;
      const TRADE_USDT_AMOUNT = ethers.parseUnits("300", USDT_DECIMALS);

      beforeEach(async function () {
        // Create order
        let tx = await bscEscrow.connect(seller).createOrder(
          USDT_AMOUNT,
          MIN_PER_TRADE,
          MAX_PER_TRADE,
          PRICE_PER_PIO
        );

        let receipt = await tx.wait();
        let event = receipt.logs.find(log => {
          try {
            return bscEscrow.interface.parseLog(log).name === "OrderCreated";
          } catch (e) {
            return false;
          }
        });
        orderId = bscEscrow.interface.parseLog(event).args.orderId;

        // Create trade
        pioneTradeId = ethers.keccak256(ethers.toUtf8Bytes("pione_trade_1"));
        await bscEscrow.connect(bridgeAdmin).createTrade(
          pioneTradeId,
          orderId,
          buyer.address,
          TRADE_USDT_AMOUNT
        );
      });

      it("Should allow bridge admin to expire trade and unlock USDT back to order", async function () {
        const orderBefore = await bscEscrow.getOrder(orderId);
        const availableBefore = orderBefore.availableUSDT;

        await bscEscrow.connect(bridgeAdmin).expireTrade(pioneTradeId);

        const orderAfter = await bscEscrow.getOrder(orderId);
        expect(orderAfter.availableUSDT).to.equal(availableBefore + TRADE_USDT_AMOUNT);

        // Verify trade status and sync flag
        const trade = await bscEscrow.getSellUSDTTrade(pioneTradeId);
        expect(trade.status).to.equal(3); // TradeStatus.Expired
        expect(await bscEscrow.crossChainExpireSynced(pioneTradeId)).to.be.true;
      });
    });

    describe("7. PancakeSwap Price Oracle", function () {
      it("Should get correct PIO price from PancakeSwap pair", async function () {
        const price = await bscEscrow.getCurrentPIOPrice();
        // Expected: (500000 USDT * 1e18) / 1000000 PIO = 0.5 USDT per PIO
        const expectedPrice = (USDT_RESERVE * ethers.parseEther("1")) / PIO_RESERVE;
        expect(price).to.equal(expectedPrice);
      });

      it("Should reject invalid reserves", async function () {
        // Deploy pair with zero reserves
        const MockPancakePair = await ethers.getContractFactory("MockPancakePair");
        const badPair = await MockPancakePair.deploy(
          await mockPIO.getAddress(),
          await mockUSDT.getAddress()
        );

        // Deploy escrow with bad pair
        const BSCP2PEscrow = await ethers.getContractFactory("BSCP2PEscrow");
        const badEscrow = await BSCP2PEscrow.deploy(
          await mockUSDT.getAddress(),
          await mockPIO.getAddress(),
          await badPair.getAddress(),
          feeRecipient.address
        );

        await expect(
          badEscrow.getCurrentPIOPrice()
        ).to.be.revertedWith("Invalid reserves");
      });
    });
  });
});
