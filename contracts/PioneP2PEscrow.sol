// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IPriceOracle } from "./interfaces/IPriceOracle.sol";

/**
 * @title PioneP2PEscrow
 * @notice Manages P2P trades involving PIO on Pione Chain
 */
contract PioneP2PEscrow is ReentrancyGuard, Pausable, AccessControl {

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant BRIDGE_ADMIN_ROLE = keccak256("BRIDGE_ADMIN_ROLE");

    enum OrderStatus { None, Active, Completed, Cancelled, Expired }
    enum TradeStatus { None, Created, Paid, Expired, Cancelled }

    struct Order {
        address seller;
        uint256 totalPIO;
        uint256 availablePIO;
        uint256 minPerTrade;
        uint256 maxPerTrade;
        uint256 pricePerPIO;
        OrderStatus status;
    }

    struct SellPIOTrade {
        bytes32 orderId;
        address seller;
        address buyer;
        uint256 pioAmount;
        uint256 pricePerPIO;
        uint16 feeSnapshot;
        TradeStatus status;
    }

    struct BuyUSDTTrade {
        bytes32 bscOrderId;
        address seller;
        address buyer;
        uint256 lockedPIO;
        uint16 feeSnapshot;
        TradeStatus status;
    }

    IPriceOracle public priceOracle;
    address public feeTo;
    uint16 public feePercent = 100;        // 1% (basis points)
    uint16 public priceTolerancePercent = 1000; // 10%
    uint256 public minPioForSell;
    uint256 private _countOrder;
    uint256 private _countTrade;

    mapping(bytes32 => Order) private orders;
    mapping(bytes32 => SellPIOTrade) private sellPIOTrades;
    mapping(bytes32 => BuyUSDTTrade) private buyUSDTTrades;
    mapping(address => bytes32[]) private sellerOrders;
    mapping(address => bytes32[]) private userTrades;
    mapping(bytes32 => bytes32[]) private orderTrades;

    mapping(bytes32 => bool) public crossChainExpireSynced;

    event OrderCreated(
        bytes32 indexed orderId,
        address indexed seller,
        uint256 totalPIO,
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
        bytes32 indexed bscOrderId,
        address buyer,
        uint256 pioAmount
    );

    event PIOReleased(bytes32 indexed tradeId, address recipient, uint256 amount);
    event TradeExpired(bytes32 indexed tradeId);
    event TradeCancelled(bytes32 indexed tradeId);
    event RequestExpired(bytes32 indexed tradeId);
    event RequestCancelled(bytes32 indexed tradeId);

    event PriceToleranceUpdated(uint16 oldValue, uint16 newValue);
    event MinPioForSellUpdated(uint256 oldValue, uint256 newValue);
    event FeeToUpdated(address oldAddress, address newAddress);

    modifier onlyBridgeAdmin() {
        require(hasRole(BRIDGE_ADMIN_ROLE, msg.sender), "Only bridge admin");
        _;
    }

    modifier orderExists(bytes32 _orderId) {
        require(orders[_orderId].seller != address(0), "Order does not exist");
        _;
    }

    constructor(address _priceOracle, address _feeTo) {
        require(_priceOracle != address(0), "Invalid oracle");
        priceOracle = IPriceOracle(_priceOracle);
        feeTo = _feeTo;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);
        _grantRole(BRIDGE_ADMIN_ROLE, msg.sender);
    }

    /**
     * @notice Create a new order to sell PIO
     */
    function createOrder(
        uint256 _minPerTrade,
        uint256 _maxPerTrade,
        uint256 _pricePerPIO
    ) external payable whenNotPaused nonReentrant returns (bytes32) {
        require(msg.value >= minPioForSell, "Invalid PIO amount");
        require(_maxPerTrade > _minPerTrade && _maxPerTrade <= msg.value, "Invalid range");

        // Validate price
        uint256 oraclePrice = priceOracle.nativePriceInUSD();
        uint256 minPrice = (oraclePrice * (10000 - priceTolerancePercent)) / 10000;
        uint256 maxPrice = (oraclePrice * (10000 + priceTolerancePercent)) / 10000;
        require(_pricePerPIO >= minPrice && _pricePerPIO <= maxPrice, "Price out of range");

        bytes32 orderId = keccak256(abi.encodePacked(
            msg.sender,
            msg.value,
            _countOrder++,
            block.timestamp
        ));

        orders[orderId] = Order({
            seller: msg.sender,
            totalPIO: msg.value,
            availablePIO: msg.value,
            minPerTrade: _minPerTrade,
            maxPerTrade: _maxPerTrade,
            pricePerPIO: _pricePerPIO,
            status: OrderStatus.Active
        });

        sellerOrders[msg.sender].push(orderId);
        emit OrderCreated(orderId, msg.sender, msg.value, _minPerTrade, _maxPerTrade, _pricePerPIO);
        return orderId;
    }

    /**
     * @notice Create a trade request to buy USDT
     */
    function createTradeRequest(
        bytes32 _bscOrderId,
        address _seller
    ) external payable whenNotPaused nonReentrant returns (bytes32 tradeId) {
        require(_seller != address(0), "Invalid seller");
        require(msg.value > 0, "Invalid PIO amount");

        tradeId = keccak256(abi.encodePacked(
            _bscOrderId,
            msg.sender,
            msg.value,
            _countTrade++,
            block.timestamp
        ));
        require(buyUSDTTrades[tradeId].seller == address(0), "Trade exists");

        buyUSDTTrades[tradeId] = BuyUSDTTrade({
            bscOrderId: _bscOrderId,
            seller: _seller,
            buyer: msg.sender,
            lockedPIO: msg.value,
            feeSnapshot: (feeTo != address(0)) ? feePercent : 0,
            status: TradeStatus.Created
        });
        userTrades[msg.sender].push(tradeId);

        emit TradeRequestCreated(
            tradeId,
            _bscOrderId,
            msg.sender,
            msg.value
        );
    }

    /**
     * @notice Create a trade for selling PIO
     */
    function createTrade(
        bytes32 _bscTradeId,
        bytes32 _orderId,
        address _buyer,
        uint256 _pioAmount
    ) external whenNotPaused onlyBridgeAdmin returns (bool) {
        Order storage order = orders[_orderId];
        require(order.status == OrderStatus.Active, "Order not active");
        require(_pioAmount <= order.availablePIO, "Insufficient PIO");
        require(_pioAmount >= order.minPerTrade && _pioAmount <= order.maxPerTrade, "Invalid amount");
        require(sellPIOTrades[_bscTradeId].seller == address(0), "Trade exists");

        // Lock PIO from order
        order.availablePIO -= _pioAmount;
        uint256 usdtAmount = (_pioAmount * order.pricePerPIO) / 1e18;

        sellPIOTrades[_bscTradeId] = SellPIOTrade({
            orderId: _orderId,
            seller: order.seller,
            buyer: _buyer,
            pioAmount: _pioAmount,
            pricePerPIO: order.pricePerPIO,
            feeSnapshot: (feeTo != address(0)) ? feePercent : 0,
            status: TradeStatus.Created
        });
        orderTrades[_orderId].push(_bscTradeId);

        emit TradeCreated(
            _bscTradeId,
            _orderId,
            _buyer,
            usdtAmount
        );
        return true;
    }

    /**
     * @notice Release PIO to buyer after confirming USDT payment on BSC
     */
    function releasePIOForBuyer(bytes32 _tradeId)
        external
        whenNotPaused
        nonReentrant
        onlyBridgeAdmin
    {
        SellPIOTrade storage trade = sellPIOTrades[_tradeId];
        require(trade.status == TradeStatus.Created, "Invalid status");

        uint256 fee;
        uint256 buyerAmount = trade.pioAmount;

        if (trade.feeSnapshot > 0 && feeTo != address(0)) {
            fee = (trade.pioAmount * trade.feeSnapshot) / 10000;
            buyerAmount -= fee;
        }

        (bool s1,) = payable(trade.buyer).call{value: buyerAmount}("");
        require(s1, "Transfer failed");

        if (fee > 0) {
            (bool s2,) = payable(feeTo).call{value: fee}("");
            require(s2, "Fee transfer failed");
        }
        trade.status = TradeStatus.Paid;
        emit PIOReleased(_tradeId, trade.buyer, buyerAmount);
    }

    /**
     * @notice Release PIO to USDT seller
     */
    function releasePIOForSeller(bytes32 _tradeId)
        external
        whenNotPaused
        nonReentrant
        onlyBridgeAdmin
    {
        BuyUSDTTrade storage trade = buyUSDTTrades[_tradeId];
        require(trade.status == TradeStatus.Created, "Not locked");

        uint256 fee;
        uint256 sellerAmount = trade.lockedPIO;

        if (trade.feeSnapshot > 0 && feeTo != address(0)) {
            fee = (trade.lockedPIO * trade.feeSnapshot) / 10000;
            sellerAmount -= fee;
        }

        // Transfer PIO to seller
        (bool s1,) = payable(trade.seller).call{value: sellerAmount}("");
        require(s1, "Transfer failed");

        if (fee > 0) {
            (bool s2,) = payable(feeTo).call{value: fee}("");
            require(s2, "Fee transfer failed");
        }

        trade.status = TradeStatus.Paid;
        emit PIOReleased(_tradeId, trade.seller, sellerAmount);
    }

    /**
     * @notice Cancel an active order and refund remaining PIO
     */
    function cancelOrder(bytes32 _orderId) external  nonReentrant {
        Order storage order = orders[_orderId];
        require(order.seller != address(0), "Order not found");
        require(msg.sender == order.seller || hasRole(BRIDGE_ADMIN_ROLE, msg.sender), "Not seller");
        require(order.status == OrderStatus.Active, "Cannot cancel");

        bytes32[] memory trades = orderTrades[_orderId];

        for (uint256 i = 0; i < trades.length; i++) {
            SellPIOTrade storage trade = sellPIOTrades[trades[i]];
            require(
                trade.status == TradeStatus.Paid ||
                trade.status == TradeStatus.Expired ||
                trade.status == TradeStatus.Cancelled,
                "Trade not finalized"
            );
        }

        uint256 refund = order.availablePIO;
        order.status = OrderStatus.Cancelled;
        order.availablePIO = 0;

        if (refund > 0) {
            (bool success,) = payable(order.seller).call{value: refund}("");
            require(success, "Refund failed");
        }

        emit OrderCancelled(_orderId);
    }


    /**
     * @notice Cancel a SellPIO trade and unlock PIO back to order
     */
    function cancelTrade(bytes32 _tradeId)
        external
        nonReentrant
        onlyBridgeAdmin
    {
        SellPIOTrade storage trade = sellPIOTrades[_tradeId];
        require(trade.status == TradeStatus.Created, "Cannot cancel");

        Order storage order = orders[trade.orderId];
        order.availablePIO += trade.pioAmount;

        trade.status = TradeStatus.Cancelled;
        emit TradeCancelled(_tradeId);
    }

    /**
     * @notice Cancel a BuyUSDT trade request and refund locked PIO to buyer
     */
    function cancelRequest(bytes32 _tradeId)
        external
        nonReentrant
        onlyBridgeAdmin
    {
        BuyUSDTTrade storage trade = buyUSDTTrades[_tradeId];
        require(trade.status == TradeStatus.Created, "Cannot cancel");

        // Refund PIO to buyer
        (bool success,) = payable(trade.buyer).call{value: trade.lockedPIO}("");
        require(success, "Refund failed");

        trade.status = TradeStatus.Cancelled;
        emit RequestCancelled(_tradeId);
    }

    /**
     * @notice Admin synchronizes expiration of SellPIO
     */
    function expireTrade(bytes32 _tradeId)
        external
        nonReentrant
        onlyBridgeAdmin
    {
        SellPIOTrade storage trade = sellPIOTrades[_tradeId];
        require(trade.status == TradeStatus.Created, "Invalid status");

        // Unlock PIO back to order
        Order storage order = orders[trade.orderId];
        order.availablePIO += trade.pioAmount;

        trade.status = TradeStatus.Expired;
        crossChainExpireSynced[_tradeId] = true;

        emit TradeExpired(_tradeId);
    }

    /**
     * @notice Admin synchronizes expiration of BuyUSDT
     */
    function expireRequest(bytes32 _tradeId)
        external
        nonReentrant
        onlyBridgeAdmin
    {
        BuyUSDTTrade storage trade = buyUSDTTrades[_tradeId];
        require(trade.status == TradeStatus.Created, "Invalid status");

        (bool success,) = payable(trade.buyer).call{value: trade.lockedPIO}("");
        require(success, "Refund failed");

        trade.status = TradeStatus.Expired;
        crossChainExpireSynced[_tradeId] = true;

        emit RequestExpired(_tradeId);
    }

    /**
     * @notice Batch expire multiple SellPIO trades at once
     */
    function batchExpireTrades(bytes32[] calldata _tradeIds) external onlyBridgeAdmin {
        for (uint256 i = 0; i < _tradeIds.length; i++) {
            _expireSellPIOTradeInternal(_tradeIds[i]);
        }
    }

    function _expireSellPIOTradeInternal(bytes32 _tradeId) private {
        SellPIOTrade storage trade = sellPIOTrades[_tradeId];
        if (trade.status == TradeStatus.Created) {
            Order storage order = orders[trade.orderId];
            order.availablePIO += trade.pioAmount;

            trade.status = TradeStatus.Expired;
            emit TradeExpired(_tradeId);
        }
    }

    function getOrder(bytes32 _orderId) external view returns (Order memory) {
        return orders[_orderId];
    }

    function getSellPIOTrade(bytes32 _tradeId) external view returns (SellPIOTrade memory) {
        return sellPIOTrades[_tradeId];
    }

    function getBuyUSDTTrade(bytes32 _tradeId) external view returns (BuyUSDTTrade memory) {
        return buyUSDTTrades[_tradeId];
    }

    function getSellerOrders(address _seller) external view returns (bytes32[] memory) {
        return sellerOrders[_seller];
    }

    function getOrderTrades(bytes32 _orderId) external view returns (bytes32[] memory) {
        return orderTrades[_orderId];
    }

    function getUserTrades(address _user) external view returns (bytes32[] memory) {
        return userTrades[_user];
    }

    function getCurrentPIOPrice() external view returns (uint256) {
        return priceOracle.nativePriceInUSD();
    }

    function getPriceRange() external view returns (uint256 minPrice, uint256 maxPrice, uint256 currentPrice) {
        currentPrice = priceOracle.nativePriceInUSD();
        minPrice = (currentPrice * (10000 - priceTolerancePercent)) / 10000;
        maxPrice = (currentPrice * (10000 + priceTolerancePercent)) / 10000;
    }

    function estimatePIOAmount(uint256 _usdtAmount) external view returns (uint256) {
        uint256 price = priceOracle.nativePriceInUSD();
        return (_usdtAmount * 1e18) / price;
    }

    /**
     * @notice Update the trade amount limits for an existing order
     */
    function updateOrderLimits(
        bytes32 _orderId,
        uint256 _newMinPerTrade,
        uint256 _newMaxPerTrade
    ) external orderExists(_orderId) {
        Order storage order = orders[_orderId];
        require(msg.sender == order.seller, "Not seller");
        require(order.status == OrderStatus.Active, "Order not active");
        require(_newMaxPerTrade > _newMinPerTrade, "Invalid range");
        require(_newMaxPerTrade <= order.totalPIO, "Max exceeds total");

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

        // Validate price against oracle
        uint256 oraclePrice = priceOracle.nativePriceInUSD();
        uint256 minPrice = (oraclePrice * (10000 - priceTolerancePercent)) / 10000;
        uint256 maxPrice = (oraclePrice * (10000 + priceTolerancePercent)) / 10000;
        require(_newPricePerPIO >= minPrice && _newPricePerPIO <= maxPrice, "Price out of range");

        order.pricePerPIO = _newPricePerPIO;
    }

    /**
     * @notice Update the platform fee percentage
     * @param _newFee New fee percentage in basis points (max 1000 = 10%)
     * @dev Only admin can call. Fee cannot exceed 10%.
     */
    function updateFee(uint16 _newFee) external onlyRole(ADMIN_ROLE) {
        require(_newFee <= 1000, "Fee too high");
        feePercent = _newFee;
    }

    function updateOracle(address _newOracle) external onlyRole(ADMIN_ROLE) {
        require(_newOracle != address(0), "Invalid oracle");
        priceOracle = IPriceOracle(_newOracle);
    }

    function updatePriceTolerance(uint16 _newTolerance) external onlyRole(ADMIN_ROLE) {
        uint16 oldValue = priceTolerancePercent;
        priceTolerancePercent = _newTolerance;
        emit PriceToleranceUpdated(oldValue, _newTolerance);
    }

    function updateMinPioForSell(uint256 _newMin) external onlyRole(ADMIN_ROLE) {
        uint256 oldValue = minPioForSell;
        minPioForSell = _newMin;
        emit MinPioForSellUpdated(oldValue, _newMin);
    }

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