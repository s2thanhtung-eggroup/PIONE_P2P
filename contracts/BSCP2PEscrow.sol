// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IPancakePair } from "./interfaces/IPancakePair.sol";

/**
 * @title BSCP2PEscrow
 * @notice Manages P2P trades involving USDT on BSC Chain
 */
contract BSCP2PEscrow is ReentrancyGuard, Pausable, AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant BRIDGE_ADMIN_ROLE = keccak256("BRIDGE_ADMIN_ROLE");

    enum OrderStatus { None, Active, Completed, Cancelled, Expired }
    enum TradeStatus { None, Created, Paid, Expired, Cancelled }

    struct Order {
        address seller;
        uint256 totalUSDT;
        uint256 availableUSDT;
        uint256 minPerTrade;
        uint256 maxPerTrade;
        uint256 pricePerPIO;
        OrderStatus status;
    }

    struct BuyPIOTrade {
        bytes32 pioneOrderId;
        address seller;
        address buyer;
        uint256 usdtAmount;
        uint16 feeSnapshot;
        TradeStatus status;
    }

    struct SellUSDTTrade {
        bytes32 orderId;
        address seller;
        address buyer;
        uint256 usdtAmount;
        uint16 feeSnapshot;
        TradeStatus status;
    }

    address public usdtAddress;
    address public pioTokenAddress;
    address public pancakePairAddress;
    address public feeTo;
    uint16 public feePercent = 100;
    uint16 public priceTolerancePercent = 1000;
    uint256 public minUsdtForSell;

    uint256 private _countOrder;
    uint256 private _countTrade;

    mapping(bytes32 => Order) private orders;
    mapping(bytes32 => BuyPIOTrade) private buyPIOTrades;
    mapping(bytes32 => SellUSDTTrade) private sellUSDTTrades;
    mapping(address => bytes32[]) private sellerOrders;
    mapping(address => bytes32[]) private userTrades;
    mapping(bytes32 => bytes32[]) private orderTrades;

    mapping(bytes32 => bool) public crossChainExpireSynced;

    event OrderCreated(
        bytes32 indexed orderId,
        address indexed seller,
        uint256 totalUSDT,
        uint256 minPerTrade,
        uint256 maxPerTrade,
        uint256 pricePerPIO
    );

    event OrderCancelled(bytes32 indexed orderId);

    event TradeCreated(
        bytes32 indexed tradeId,
        bytes32 indexed orderId,
        address buyer,
        uint256 usdtAmount
    );

    event TradeRequestCreated(
        bytes32 indexed tradeId,
        bytes32 indexed pioneOrderId,
        address buyer,
        uint256 usdtAmount
    );

    event USDTPaid(bytes32 indexed tradeId, address buyer, uint256 amount);
    event USDTReleased(bytes32 indexed tradeId, address recipient, uint256 amount);
    event TradeExpired(bytes32 indexed tradeId);
    event TradeCancelled(bytes32 indexed tradeId);
    event RequestExpired(bytes32 indexed tradeId);
    event RequestCancelled(bytes32 indexed tradeId);

    event PriceToleranceUpdated(uint16 oldValue, uint16 newValue);
    event MinUsdtForSellUpdated(uint256 oldValue, uint256 newValue);
    event FeeToUpdated(address oldAddress, address newAddress);

    modifier onlyBridgeAdmin() {
        require(hasRole(BRIDGE_ADMIN_ROLE, msg.sender), "Only bridge admin");
        _;
    }

    modifier orderExists(bytes32 _orderId) {
        require(orders[_orderId].seller != address(0), "Order does not exist");
        _;
    }

    constructor(
        address _usdtAddress,
        address _pioTokenAddress,
        address _pancakePairAddress,
        address _feeTo
    ) {
        require(_usdtAddress != address(0), "Invalid USDT");
        require(_pioTokenAddress != address(0), "Invalid PIO");
        require(_pancakePairAddress != address(0), "Invalid pair");

        usdtAddress = _usdtAddress;
        pioTokenAddress = _pioTokenAddress;
        pancakePairAddress = _pancakePairAddress;
        feeTo = _feeTo;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);
        _grantRole(BRIDGE_ADMIN_ROLE, msg.sender);
    }

    /**
     * @notice Create a new order to sell USDT
     */
    function createOrder(
        uint256 _usdtAmount,
        uint256 _minPerTrade,
        uint256 _maxPerTrade,
        uint256 _pricePerPIO
    ) external whenNotPaused nonReentrant returns (bytes32) {
        require(_usdtAmount >= minUsdtForSell, "Invalid amount");
        require(_maxPerTrade > _minPerTrade && _maxPerTrade <= _usdtAmount, "Invalid range");

        // Validate price
        uint256 currentPrice = getCurrentPIOPrice();
        uint256 minPrice = (currentPrice * (10000 - priceTolerancePercent)) / 10000;
        uint256 maxPrice = (currentPrice * (10000 + priceTolerancePercent)) / 10000;
        require(_pricePerPIO >= minPrice && _pricePerPIO <= maxPrice, "Price out of range");

        bytes32 orderId = keccak256(abi.encodePacked(
            msg.sender,
            _usdtAmount,
            _countOrder++,
            block.timestamp
        ));

        IERC20(usdtAddress).safeTransferFrom(msg.sender, address(this), _usdtAmount);

        orders[orderId] = Order({
            seller: msg.sender,
            totalUSDT: _usdtAmount,
            availableUSDT: _usdtAmount,
            minPerTrade: _minPerTrade,
            maxPerTrade: _maxPerTrade,
            pricePerPIO: _pricePerPIO,
            status: OrderStatus.Active
        });

        sellerOrders[msg.sender].push(orderId);

        emit OrderCreated(orderId, msg.sender, _usdtAmount, _minPerTrade, _maxPerTrade, _pricePerPIO);
        return orderId;
    }

    /**
     * @notice Create a trade request to buy PIO (user must lock USDT)
     */
    function createTradeRequest(
        bytes32 _pioneOrderId,
        address _seller,
        uint256 _usdtAmount
    ) external whenNotPaused nonReentrant returns (bytes32 tradeId) {
        require(_seller != address(0), "Invalid seller");
        require(_usdtAmount > 0, "Invalid amount");

        tradeId = keccak256(abi.encodePacked(
            _pioneOrderId,
            msg.sender,
            _usdtAmount,
            _countTrade++,
            block.timestamp
        ));
        require(buyPIOTrades[tradeId].seller == address(0), "Trade exists");

        IERC20(usdtAddress).safeTransferFrom(msg.sender, address(this), _usdtAmount);

        buyPIOTrades[tradeId] = BuyPIOTrade({
            pioneOrderId: _pioneOrderId,
            seller: _seller,
            buyer: msg.sender,
            usdtAmount: _usdtAmount,
            feeSnapshot: (feeTo != address(0)) ? feePercent : 0,
            status: TradeStatus.Created
        });

        userTrades[msg.sender].push(tradeId);

        emit TradeRequestCreated(
            tradeId,
            _pioneOrderId,
            msg.sender,
            _usdtAmount
        );
    }

    /**
     * @notice Create a trade and lock USDT from an order
     */
    function createTrade(
        bytes32 _pioneTradeId,
        bytes32 _orderId,
        address _buyer,
        uint256 _usdtAmount
    ) external whenNotPaused onlyBridgeAdmin returns (bool) {
        Order storage order = orders[_orderId];
        require(order.status == OrderStatus.Active, "Order not active");
        require(_usdtAmount <= order.availableUSDT, "Insufficient USDT");
        require(_usdtAmount >= order.minPerTrade && _usdtAmount <= order.maxPerTrade, "Invalid amount");
        require(sellUSDTTrades[_pioneTradeId].seller == address(0), "Trade exists");
        order.availableUSDT -= _usdtAmount;

        sellUSDTTrades[_pioneTradeId] = SellUSDTTrade({
            orderId: _orderId,
            seller: order.seller,
            buyer: _buyer,
            usdtAmount: _usdtAmount,
            feeSnapshot: (feeTo != address(0)) ? feePercent : 0,
            status: TradeStatus.Created
        });
        orderTrades[_orderId].push(_pioneTradeId);

        emit TradeCreated(
            _pioneTradeId,
            _orderId,
            _buyer,
            _usdtAmount
        );
        return true;
    }

    /**
     * @notice Release USDT to PIO seller after PIO is released on Pione chain
     */
    function releaseUSDTForSeller(bytes32 _tradeId)
        external
        whenNotPaused
        onlyBridgeAdmin
        nonReentrant
    {
        BuyPIOTrade storage trade = buyPIOTrades[_tradeId];
        require(trade.status == TradeStatus.Created, "Invalid status");

        uint256 fee;
        uint256 sellerAmount = trade.usdtAmount;

        if (trade.feeSnapshot > 0 && feeTo != address(0)) {
            fee = (trade.usdtAmount * trade.feeSnapshot) / 10000;
            sellerAmount -= fee;
        }

        // Transfer USDT to seller (PIO seller on Pione)
        IERC20(usdtAddress).safeTransfer(trade.seller, sellerAmount);
        if (fee > 0) {
            IERC20(usdtAddress).safeTransfer(feeTo, fee);
        }
        trade.status = TradeStatus.Paid;

        emit USDTPaid(_tradeId, trade.buyer, trade.usdtAmount);
    }

    /**
     * @notice Release USDT to buyer
     */
    function releaseUSDTForBuyer(bytes32 _tradeId)
        external
        whenNotPaused
        onlyBridgeAdmin
        nonReentrant
    {
        SellUSDTTrade storage trade = sellUSDTTrades[_tradeId];
        require(trade.status == TradeStatus.Created, "Invalid status");

        uint256 fee;
        uint256 buyerAmount = trade.usdtAmount;
        if (trade.feeSnapshot > 0 && feeTo != address(0)) {
            fee = (trade.usdtAmount * trade.feeSnapshot) / 10000;
            buyerAmount -= fee;
        }

        // Transfer USDT directly to buyer
        IERC20(usdtAddress).safeTransfer(trade.buyer, buyerAmount);
        if (fee > 0) {
            IERC20(usdtAddress).safeTransfer(feeTo, fee);
        }

        trade.status = TradeStatus.Paid;
        emit USDTReleased(_tradeId, trade.buyer, buyerAmount);
    }

    /**
     * @notice Cancel an active order and refund remaining USDT
     */
    function cancelOrder(bytes32 _orderId) external nonReentrant {
        Order storage order = orders[_orderId];
        require(msg.sender == order.seller || hasRole(BRIDGE_ADMIN_ROLE, msg.sender), "Not seller");
        require(order.status == OrderStatus.Active, "Cannot cancel");

        bytes32[] memory trades = orderTrades[_orderId];
        for (uint256 i = 0; i < trades.length; i++) {
            SellUSDTTrade storage trade = sellUSDTTrades[trades[i]];
            require(
                trade.status == TradeStatus.Paid ||
                trade.status == TradeStatus.Expired ||
                trade.status == TradeStatus.Cancelled,
                "Trade not finalized"
            );
        }
        uint256 refund = order.availableUSDT;
        order.status = OrderStatus.Cancelled;
        order.availableUSDT = 0;

        if (refund > 0) {
            IERC20(usdtAddress).safeTransfer(order.seller, refund);
        }
        emit OrderCancelled(_orderId);
    }

    /**
     * @notice Batch expire multiple SellUSDT trades at once
     */
    function batchExpireTrades(bytes32[] calldata _tradeIds) external onlyBridgeAdmin() {
        for (uint256 i = 0; i < _tradeIds.length; i++) {
            _expireSellUSDTTradeInternal(_tradeIds[i]);
        }
    }

    function _expireSellUSDTTradeInternal(bytes32 _tradeId) private {
        SellUSDTTrade storage trade = sellUSDTTrades[_tradeId];
        if (trade.status == TradeStatus.Created) {
            // Unlock USDT back to order
            Order storage order = orders[trade.orderId];
            order.availableUSDT += trade.usdtAmount;

            trade.status = TradeStatus.Expired;
            emit TradeExpired(_tradeId);
        }
    }

    /**
     * @notice Cancel a SellUSDT trade and unlock USDT back to order
     */
    function cancelTrade(bytes32 _tradeId)
        external
        nonReentrant
        onlyBridgeAdmin
    {
        SellUSDTTrade storage trade = sellUSDTTrades[_tradeId];
        require(trade.status == TradeStatus.Created, "Cannot cancel");

        Order storage order = orders[trade.orderId];
        order.availableUSDT += trade.usdtAmount;
        trade.status = TradeStatus.Cancelled;
        emit TradeCancelled(_tradeId);
    }

    /**
     * @notice Cancel a BuyPIO trade request and refund USDT to buyer
     * @dev Only bridge admin can call. Refunds locked USDT back to buyer.
     */
    function cancelRequest(bytes32 _tradeId)
        external
        nonReentrant
        onlyBridgeAdmin
    {
        BuyPIOTrade storage trade = buyPIOTrades[_tradeId];
        require(trade.status == TradeStatus.Created, "Cannot cancel");

        IERC20(usdtAddress).safeTransfer(trade.buyer, trade.usdtAmount);

        trade.status = TradeStatus.Cancelled;
        emit RequestCancelled(_tradeId);
    }

    /**
     * @notice Admin synchronizes expiration of BuyPIO trade after Pione expiration
     * @dev Refunds locked USDT back to buyer
     */
    function expireRequest(bytes32 _tradeId)
        external
        nonReentrant
        onlyBridgeAdmin
    {
        BuyPIOTrade storage trade = buyPIOTrades[_tradeId];
        require(trade.status == TradeStatus.Created, "Invalid status");

        IERC20(usdtAddress).safeTransfer(trade.buyer, trade.usdtAmount);

        trade.status = TradeStatus.Expired;
        crossChainExpireSynced[_tradeId] = true;

        emit RequestExpired(_tradeId);
    }

    /**
     * @notice Admin synchronizes expiration of SellUSDT trade after Pione expiration
     */
    function expireTrade(bytes32 _tradeId)
        external
        nonReentrant
        onlyBridgeAdmin
    {
        SellUSDTTrade storage trade = sellUSDTTrades[_tradeId];
        require(trade.status == TradeStatus.Created, "Invalid status");

        // Unlock USDT back to order
        Order storage order = orders[trade.orderId];
        order.availableUSDT += trade.usdtAmount;

        trade.status = TradeStatus.Expired;
        crossChainExpireSynced[_tradeId] = true;

        emit TradeExpired(_tradeId);
    }

    function getOrder(bytes32 _orderId) external view returns (Order memory) {
        return orders[_orderId];
    }

    function getBuyPIOTrade(bytes32 _tradeId) external view returns (BuyPIOTrade memory) {
        return buyPIOTrades[_tradeId];
    }

    function getSellUSDTTrade(bytes32 _tradeId) external view returns (SellUSDTTrade memory) {
        return sellUSDTTrades[_tradeId];
    }

    function getSellerOrders(address _seller) external view returns (bytes32[] memory) {
        return sellerOrders[_seller];
    }

    function getOrderTrades(bytes32 _orderId) external view returns (bytes32[] memory) {
        return orderTrades[_orderId];
    }
    
    function estimateUSDTForOrder(bytes32 _orderId, uint256 _pioAmount) external view returns (uint256) {
        Order storage order = orders[_orderId];
        require(order.seller != address(0), "Order does not exist");
        return (_pioAmount * order.pricePerPIO) / 1e18;
    }

    function getCurrentPIOPrice() public view returns (uint256) {
        IPancakePair pair = IPancakePair(pancakePairAddress);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        require(r0 > 0 && r1 > 0, "Invalid reserves");

        (uint256 pioReserve, uint256 usdtReserve) = pair.token0() == pioTokenAddress
            ? (r0, r1)
            : (r1, r0);

        return (usdtReserve * 1e18) / pioReserve;
    }

    function getPriceRange() external view returns (uint256 minPrice, uint256 maxPrice, uint256 currentPrice) {
        currentPrice = getCurrentPIOPrice();
        minPrice = (currentPrice * (10000 - priceTolerancePercent)) / 10000;
        maxPrice = (currentPrice * (10000 + priceTolerancePercent)) / 10000;
    }

    function estimatePIOAmount(uint256 _usdtAmount) external view returns (uint256) {
        uint256 price = getCurrentPIOPrice();
        return (_usdtAmount * 1e18) / price;
    }

    function getUserTrades(address _user) external view returns (bytes32[] memory) {
        return userTrades[_user];
    }

    function updateFee(uint16 _newFee) external onlyRole(ADMIN_ROLE) {
        require(_newFee <= 1000, "Fee too high");
        feePercent = _newFee;
    }

    function updatePancakePair(address _newPair) external onlyRole(ADMIN_ROLE) {
        require(_newPair != address(0), "Invalid pair");
        pancakePairAddress = _newPair;
    }

    function updateOrderLimits(
        bytes32 _orderId,
        uint256 _newMinPerTrade,
        uint256 _newMaxPerTrade
    ) external orderExists(_orderId) {
        Order storage order = orders[_orderId];
        require(msg.sender == order.seller, "Not seller");
        require(order.status == OrderStatus.Active, "Order not active");
        require(_newMaxPerTrade > _newMinPerTrade, "Invalid range");
        require(_newMaxPerTrade <= order.totalUSDT, "Max exceeds total");

        order.minPerTrade = _newMinPerTrade;
        order.maxPerTrade = _newMaxPerTrade;
    }

    function updateOrderPrice(
        bytes32 _orderId,
        uint256 _newPricePerPIO
    ) external orderExists(_orderId) {
        Order storage order = orders[_orderId];
        require(msg.sender == order.seller, "Not seller");
        require(order.status == OrderStatus.Active, "Order not active");

        uint256 currentPrice = getCurrentPIOPrice();
        uint256 minPrice = (currentPrice * (10000 - priceTolerancePercent)) / 10000;
        uint256 maxPrice = (currentPrice * (10000 + priceTolerancePercent)) / 10000;
        require(_newPricePerPIO >= minPrice && _newPricePerPIO <= maxPrice, "Price out of range");

        order.pricePerPIO = _newPricePerPIO;
    }

    function updatePriceTolerance(uint16 _newTolerance) external onlyRole(ADMIN_ROLE) {
        uint16 oldValue = priceTolerancePercent;
        priceTolerancePercent = _newTolerance;
        emit PriceToleranceUpdated(oldValue, _newTolerance);
    }

    function updateMinUsdtForSell(uint256 _newMin) external onlyRole(ADMIN_ROLE) {
        uint256 oldValue = minUsdtForSell;
        minUsdtForSell = _newMin;
        emit MinUsdtForSellUpdated(oldValue, _newMin);
    }

    /**
     * @notice Update the fee recipient address
     * @dev Only admin can call. If set to zero address, fees will be disabled.
     */
    function updateFeeTo(address _newFeeTo) external onlyRole(ADMIN_ROLE) {
        address oldAddress = feeTo;
        feeTo = _newFeeTo;
        emit FeeToUpdated(oldAddress, _newFeeTo);
    }

    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }
}