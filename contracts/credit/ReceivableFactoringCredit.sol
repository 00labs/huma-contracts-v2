// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IERC721, IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Credit} from "./Credit.sol";
import {ReceivableInput, CreditRecord} from "./CreditStructs.sol";
import {IReceivableFactoringCredit} from "./interfaces/IReceivableFactoringCredit.sol";
import {PoolConfig} from "../PoolConfig.sol";
import {Errors} from "../Errors.sol";

contract ReceivableFactoringCredit is
    Credit,
    AccessControlUpgradeable,
    IReceivableFactoringCredit,
    IERC721Receiver
{
    bytes32 public constant PAYER_ROLE = keccak256("PAYER");

    event ExtraFundsDispersed(address indexed receiver, uint256 amount);

    //TODO add events

    function initialize(PoolConfig _poolConfig) public virtual override initializer {
        __AccessControl_init();
        _initialize(_poolConfig);
        __UUPSUpgradeable_init();
    }

    function addPayer(address payer) external virtual {
        poolConfig.onlyPoolOwner(msg.sender); // TODO operator?
        if (payer == address(0)) revert Errors.zeroAddressProvided();
        _grantRole(PAYER_ROLE, payer);
    }

    function removePayer(address payer) external virtual {
        poolConfig.onlyPoolOwner(msg.sender); // TODO
        if (payer == address(0)) revert Errors.zeroAddressProvided();
        _revokeRole(PAYER_ROLE, payer);
    }

    /// @inheritdoc IReceivableFactoringCredit
    function approveReceivable(
        address borrower,
        ReceivableInput memory receivableInput,
        uint96 creditLimit,
        uint16 remainingPeriods,
        uint16 yieldInBps,
        uint96 committedAmount
    ) external virtual {
        poolConfig.onlyProtocolAndPoolOn();
        _onlyEAServiceAccount();

        bytes32 creditHash = _getCreditHash(receivableInput.receivableId);
        _approveCredit(
            borrower,
            creditHash,
            creditLimit,
            remainingPeriods,
            yieldInBps,
            committedAmount,
            false
        );
    }

    /// @inheritdoc IReceivableFactoringCredit
    function refreshCredit(uint256 receivableId) external virtual {
        bytes32 creditHash = _getCreditHash(receivableId);
        _refreshCredit(creditHash);
    }

    /// @inheritdoc IReceivableFactoringCredit
    function triggerDefault(
        uint256 receivableId
    ) external virtual returns (uint256 principalLoss, uint256 yieldLoss, uint256 feesLoss) {
        bytes32 creditHash = _getCreditHash(receivableId);
        return _triggerDefault(creditHash);
    }

    /// @inheritdoc IReceivableFactoringCredit
    function closeCredit(uint256 receivableId) external virtual {
        bytes32 creditHash = _getCreditHash(receivableId);
        _closeCredit(creditHash);
    }

    /// @inheritdoc IReceivableFactoringCredit
    function pauseCredit(uint256 receivableId) external virtual {
        bytes32 creditHash = _getCreditHash(receivableId);
        _pauseCredit(creditHash);
    }

    /// @inheritdoc IReceivableFactoringCredit
    function unpauseCredit(uint256 receivableId) external virtual {
        bytes32 creditHash = _getCreditHash(receivableId);
        _unpauseCredit(creditHash);
    }

    /// @inheritdoc IReceivableFactoringCredit
    function updateYield(uint256 receivableId, uint256 yieldInBps) external virtual {
        bytes32 creditHash = _getCreditHash(receivableId);
        _updateYield(creditHash, yieldInBps);
    }

    /// @inheritdoc IReceivableFactoringCredit
    function updateLimitAndCommitment(
        uint256 receivableId,
        uint256 creditLimit,
        uint256 committedAmount
    ) external {
        bytes32 creditHash = _getCreditHash(receivableId);
        _updateLimitAndCommitment(creditHash, creditLimit, committedAmount);
    }

    /// @inheritdoc IReceivableFactoringCredit
    function extendRemainingPeriod(uint256 receivableId, uint256 numOfPeriods) external virtual {
        _onlyEAServiceAccount();
        bytes32 creditHash = _getCreditHash(receivableId);
        _extendRemainingPeriod(creditHash, numOfPeriods);
    }

    /// @inheritdoc IReceivableFactoringCredit
    function waiveLateFee(uint256 receivableId, uint256 waivedAmount) external virtual {
        bytes32 creditHash = _getCreditHash(receivableId);
        _waiveLateFee(creditHash, waivedAmount);
    }

    function drawdownWithReceivable(
        address borrower,
        uint256 receivableId,
        uint256 amount
    ) external {
        poolConfig.onlyProtocolAndPoolOn();

        if (msg.sender != borrower) revert Errors.notBorrower();
        if (receivableId == 0) revert Errors.zeroReceivableIdProvided();
        if (amount == 0) revert Errors.zeroAmountProvided();
        bytes32 creditHash = _getCreditHash(receivableId);
        if (borrower != creditBorrowerMap[creditHash]) revert Errors.notBorrower();

        IERC721 receivableAsset = IERC721(poolConfig.receivableAsset());
        receivableAsset.safeTransferFrom(borrower, address(this), receivableId);

        _drawdown(borrower, creditHash, amount);
    }

    function makePaymentWithReceivable(
        address borrower,
        uint256 receivableId,
        uint256 amount
    ) public virtual returns (uint256 amountPaid, bool paidoff) {
        poolConfig.onlyProtocolAndPoolOn();
        if (msg.sender != borrower) _onlyPayer(msg.sender);
        bytes32 creditHash = _getCreditHash(receivableId);
        if (borrower != creditBorrowerMap[creditHash]) revert Errors.notBorrower();

        (amountPaid, paidoff, ) = _makePayment(borrower, creditHash, amount);
        if (amount > amountPaid && msg.sender != borrower) {
            uint256 disbursedAmount = amount - amountPaid;
            poolSafe.deposit(msg.sender, disbursedAmount);
            poolSafe.withdraw(borrower, disbursedAmount);
            emit ExtraFundsDispersed(borrower, disbursedAmount);
        }
        if (paidoff) {
            // TODO delete receivable? transfer back?
        }
    }

    function getCreditRecord(uint256 receivableId) external view returns (CreditRecord memory) {
        bytes32 creditHash = _getCreditHash(receivableId);
        return getCreditRecord(creditHash);
    }

    function onERC721Received(
        address /*operator*/,
        address /*from*/,
        uint256 /*tokenId*/,
        bytes calldata /*data*/
    ) external virtual returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function _getCreditHash(
        uint256 receivableId
    ) internal view virtual returns (bytes32 creditHash) {
        return keccak256(abi.encode(address(this), poolConfig.receivableAsset(), receivableId));
    }

    function _onlyPayer(address account) internal view {
        if (!hasRole(PAYER_ROLE, account)) revert Errors.permissionDeniedNotPayer();
    }
}
