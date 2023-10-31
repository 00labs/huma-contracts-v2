// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HumaConfig} from "../HumaConfig.sol";
import {CreditConfig, CreditRecord, CreditLimit, DueDetail, CreditLoss} from "./CreditStructs.sol";
import {PoolConfig} from "../PoolConfig.sol";
import {ICreditFeeManager} from "./utils/interfaces/ICreditFeeManager.sol";
import {ICalendar} from "./interfaces/ICalendar.sol";
import {IPoolSafe} from "../interfaces/IPoolSafe.sol";
import {IFirstLossCover} from "../interfaces/IFirstLossCover.sol";

contract CreditStorage {
    HumaConfig internal _humaConfig;

    // Reference to the fee manager contract
    ICreditFeeManager internal _feeManager;

    ICalendar public calendar;
    IPoolSafe public poolSafe;
    IFirstLossCover public firstLossCover;

    mapping(address => CreditConfig) internal _borrowerConfigMap;
    /// mapping from credit id to the credit config
    mapping(bytes32 => CreditConfig) internal _creditConfigMap;
    /// mapping from credit id to the credit record
    mapping(bytes32 => CreditRecord) internal _creditRecordMap;
    /// mapping from credit id to the credit record
    mapping(bytes32 => DueDetail) internal _dueDetailMap;
    /// mapping from credit id to the to the CreditLoss struct
    mapping(bytes32 => CreditLoss) internal _creditLossMap;
    mapping(bytes32 => CreditLimit) internal _creditLimitMap;
    /// mapping from borrower to the credit limit at borrower-level
    mapping(address => CreditLimit) internal _borrowerLimitMap;

    //* Reserved for Richard review, to be deleted
    // This mapping is used to maintain the relationship between credit and borrower
    mapping(bytes32 => address) internal _creditBorrowerMap;

    bytes32[] public activeCreditsHash;
    bytes32[] public overdueCreditsHash;

    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     */
    uint256[100] private __gap;
}
