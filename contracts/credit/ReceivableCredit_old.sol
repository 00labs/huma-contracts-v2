// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditConfig, CreditRecord, CreditQuota, ReceivableInfo, FacilityConfig, ReceivableState} from "./CreditStructs.sol";
import {Credit} from "./Credit.sol";
import {IReceivableCredit_old} from "./interfaces/IReceivableCredit_old.sol";
import {Receivable} from "./Receivable.sol";
import {Errors} from "../Errors.sol";
import {PoolConfig, PoolSettings} from "../PoolConfig.sol";

/**
 * ReceivableCredit is a credit backed by receivables.
 */
contract ReceivableCredit_old is Credit, IReceivableCredit_old {
    // the NFT contract address for the receivable.
    // todo set Receivable in initializer.
    Receivable receivable;

    // creditHash => (receivableId => receivableId)
    // map from creditHash to the list of receivables.
    // Used a map to store a list of receivables instead of an array for efficiency consideration.
    mapping(bytes32 => mapping(uint256 => uint256)) receivableMap;

    // creditHash => FacilityConfig, the facility config for the credit
    mapping(bytes32 => FacilityConfig) facilityConfig;

    /**
     * @notice approve a borrower with set of terms. These terms will be referenced by EA
     * when credits are created for this borrower.
     * @param borrower the borrower address
     * @param creditLimit the credit limit at the borrower level
     * @param numOfPeriods how many periods are approved for the borrower
     * @param yieldInBps expected yields in basis points
     * @param committedAmount the amount the borrower committed to use.
     * @param revolving indicates if the underlying credit line is revolving or not
     * @param receivableRequired whether receivable is required as collateral before a drawdown
     * @param borrowerLevelCredit indicates whether the borrower is allowed to have one or
     * multiple credit line
     * The yield will be computed using the max of this amount and the acutal credit used.
     * @dev Please note CalendarUnit and durationPerPeriodInCalendarUnit are defined at the
     * pool level, managed by PoolConfig. They cannot be customized for each borrower or credit.
     */
    function approveBorrower(
        address borrower,
        uint96 creditLimit,
        uint16 numOfPeriods, // number of periods
        uint16 yieldInBps,
        uint96 committedAmount,
        bool revolving,
        bool receivableRequired,
        bool borrowerLevelCredit
    ) external virtual override {
        poolConfig.onlyProtocolAndPoolOn();
        onlyEAServiceAccount();

        if (creditLimit <= 0) revert();
        if (numOfPeriods <= 0) revert();

        PoolSettings memory ps = poolConfig.getPoolSettings();
        _borrowerConfigMap[borrower] = CreditConfig(
            creditLimit,
            committedAmount,
            ps.calendarUnit,
            ps.payPeriodInCalendarUnit,
            numOfPeriods,
            yieldInBps,
            revolving,
            receivableRequired,
            borrowerLevelCredit,
            true
        );

        emit BorrowerApproved(
            borrower,
            creditLimit,
            numOfPeriods,
            yieldInBps,
            committedAmount,
            revolving,
            receivableRequired,
            borrowerLevelCredit
        );
    }

    function approveReceivable(address borrower, uint256 receivableId) public {
        onlyEAServiceAccount();
        _approveReceivable(borrower, receivableId);
    }

    function _approveReceivable(address borrower, uint256 receivableId) public {
        receivable.approveOrRejectReceivable(receivableId, true);
        bytes32 creditHash = _getCreditHash(borrower, receivableId);

        CreditQuota memory quota = _creditQuotaMap[creditHash];
        quota.availableCredit +=
            receivable.getReceivable(receivableId).receivableAmount *
            facilityConfig[creditHash].advanceRateInBps;
        _creditQuotaMap[creditHash] = quota;

        // todo emit event
    }

    function rejectReceivable(address borrower, uint256 receivableId) public {
        onlyEAServiceAccount();
        receivable.approveOrRejectReceivable(receivableId, false);
        // todo emit event
    }

    function drawdownWithReceivable(
        address borrower,
        address receivableAddress,
        uint256 receivableId,
        uint256 amount,
        ReceivableInfo memory receivableInfo
    ) external {
        if (receivableAddress != address(receivable)) revert Errors.todo();
        if (receivable.ownerOf(receivableId) != borrower) revert Errors.todo();
        if (receivable.getStatus(receivableId) != ReceivableState.Approved) revert Errors.todo();

        receivable.transferFrom(borrower, address(this), receivableId);
        bytes32 creditHash = _getCreditHash(borrower, receivableId);
        _drawdown(borrower, creditHash, amount);
        // todo emit evnet
    }

    function _getCreditHash(
        address borrower,
        uint256 receivableId
    ) internal view returns (bytes32 creditHash) {
        if (_getBorrowerRecord(msg.sender).borrowerLevelCredit)
            creditHash = getCreditHash(msg.sender, receivableId);
        else creditHash = keccak256(abi.encode(borrower, address(receivable), receivableId));
    }

    function getCreditHash(
        address borrower,
        uint256 receivableId
    ) public pure returns (bytes32 creditHash) {
        return keccak256(abi.encode(borrower, receivableId));
    }
}
