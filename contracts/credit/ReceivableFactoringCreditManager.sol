// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {CreditManager} from "./CreditManager.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PoolConfig} from "../common/PoolConfig.sol";
import {Errors} from "../common/Errors.sol";
import {ReceivableInput} from "./CreditStructs.sol";
import {PayPeriodDuration} from "../common/SharedDefs.sol";
import {IReceivableFactoringCreditManager} from "./interfaces/IReceivableFactoringCreditManager.sol";

contract ReceivableFactoringCreditManager is
    CreditManager,
    AccessControlUpgradeable,
    IReceivableFactoringCreditManager
{
    bytes32 public constant PAYER_ROLE = keccak256("PAYER");

    /**
     * @notice A receivable factoring credit has been approved.
     * @param borrower The address of the borrower.
     * @param creditHash The hash of the credit.
     * @param receivableId The ID of the receivable.
     * @param receivableAmount The total expected payment amount of the receivable.
     * @param creditLimit The maximum amount that can be borrowed.
     * @param periodDuration The duration of each pay period, e.g. monthly, quarterly or semi-annually.
     * @param remainingPeriods The number of periods before the credit expires.
     * @param yieldInBps The expected yield expressed in basis points, 1% is 100, 100% is 10000.
     */
    event ReceivableFactoringCreditApproved(
        address indexed borrower,
        bytes32 indexed creditHash,
        uint256 receivableId,
        uint256 receivableAmount,
        uint256 creditLimit,
        PayPeriodDuration periodDuration,
        uint256 remainingPeriods,
        uint256 yieldInBps
    );

    /**
     * @notice A payer has been added.
     * @param payer The address of the payer being added.
     */
    event PayerAdded(address indexed payer);

    /**
     * @notice A payer has been removed.
     * @param payer The address of the payer being removed.
     */
    event PayerRemoved(address indexed payer);

    function initialize(PoolConfig _poolConfig) external virtual override initializer {
        __AccessControl_init();
        _initialize(_poolConfig);
        __UUPSUpgradeable_init();
    }

    function addPayer(address payer) external virtual {
        poolConfig.onlyPoolOperator(msg.sender);
        if (payer == address(0)) revert Errors.ZeroAddressProvided();
        _grantRole(PAYER_ROLE, payer);
        emit PayerAdded(payer);
    }

    function removePayer(address payer) external virtual {
        poolConfig.onlyPoolOperator(msg.sender);
        if (payer == address(0)) revert Errors.ZeroAddressProvided();
        _revokeRole(PAYER_ROLE, payer);
        emit PayerRemoved(payer);
    }

    /// @inheritdoc IReceivableFactoringCreditManager
    function approveReceivable(
        address borrower,
        ReceivableInput memory receivableInput,
        uint96 creditLimit,
        uint16 remainingPeriods,
        uint16 yieldInBps
    ) external virtual {
        poolConfig.onlyProtocolAndPoolOn();
        _onlyEAServiceAccount();
        if (creditLimit > receivableInput.receivableAmount)
            revert Errors.InsufficientReceivableAmount();
        if (receivableInput.receivableId == 0) revert Errors.ZeroReceivableIdProvided();

        bytes32 creditHash = getCreditHash(receivableInput.receivableId);
        _approveCredit(
            borrower,
            creditHash,
            creditLimit,
            remainingPeriods,
            yieldInBps,
            0,
            0,
            false
        );

        emit ReceivableFactoringCreditApproved(
            borrower,
            creditHash,
            receivableInput.receivableId,
            receivableInput.receivableAmount,
            creditLimit,
            getCreditConfig(creditHash).periodDuration,
            remainingPeriods,
            yieldInBps
        );
    }

    /// @inheritdoc IReceivableFactoringCreditManager
    function refreshCredit(uint256 receivableId) external virtual {
        poolConfig.onlyProtocolAndPoolOn();

        bytes32 creditHash = getCreditHash(receivableId);
        _refreshCredit(creditHash);
    }

    /// @inheritdoc IReceivableFactoringCreditManager
    function triggerDefault(
        uint256 receivableId
    ) external virtual returns (uint256 principalLoss, uint256 yieldLoss, uint256 feesLoss) {
        poolConfig.onlyProtocolAndPoolOn();
        _onlyEAServiceAccount();

        bytes32 creditHash = getCreditHash(receivableId);
        return _triggerDefault(creditHash);
    }

    /// @inheritdoc IReceivableFactoringCreditManager
    function closeCredit(address borrower, uint256 receivableId) external virtual {
        poolConfig.onlyProtocolAndPoolOn();
        if (msg.sender != borrower && msg.sender != humaConfig.eaServiceAccount())
            revert Errors.BorrowerOrEARequired();

        bytes32 creditHash = getCreditHash(receivableId);
        onlyCreditBorrower(creditHash, borrower);
        _closeCredit(creditHash);
    }

    /// @inheritdoc IReceivableFactoringCreditManager
    function updateYield(uint256 receivableId, uint256 yieldInBps) external virtual {
        poolConfig.onlyProtocolAndPoolOn();
        _onlyEAServiceAccount();

        bytes32 creditHash = getCreditHash(receivableId);
        _updateYield(creditHash, yieldInBps);
    }

    /// @inheritdoc IReceivableFactoringCreditManager
    function extendRemainingPeriod(uint256 receivableId, uint256 numOfPeriods) external virtual {
        poolConfig.onlyProtocolAndPoolOn();
        _onlyEAServiceAccount();

        bytes32 creditHash = getCreditHash(receivableId);
        _extendRemainingPeriod(creditHash, numOfPeriods);
    }

    /// @inheritdoc IReceivableFactoringCreditManager
    function waiveLateFee(uint256 receivableId, uint256 waivedAmount) external virtual {
        poolConfig.onlyProtocolAndPoolOn();
        _onlyEAServiceAccount();

        bytes32 creditHash = getCreditHash(receivableId);
        _waiveLateFee(creditHash, waivedAmount);
    }

    /// @inheritdoc IReceivableFactoringCreditManager
    function onlyPayer(address account, bytes32 creditHash) external view returns (address) {
        if (!hasRole(PAYER_ROLE, account)) revert Errors.PayerRequired();
        return _creditBorrowerMap[creditHash];
    }

    function getCreditHash(uint256 receivableId) public view virtual returns (bytes32 creditHash) {
        return keccak256(abi.encode(address(credit), poolConfig.receivableAsset(), receivableId));
    }
}
